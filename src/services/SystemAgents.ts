import { nameOf, namespaceOf, type HadesResource } from "../domain/resources.js";
import type { EventStorePort } from "../ports/EventStore.js";
import type { StateStorePort } from "../ports/StateStore.js";

/**
 * System agents (docs/system-agents.md): privileged userland daemons that manage Hades,
 * modeled as agents with elevated (but scoped) capabilities — never blanket
 * cluster-admin.
 *
 *   provisioner — creates ordinary agents, homes, listeners, schedules.
 *   janitor     — cleans expired hands, completed runs, orphaned resources.
 *   auditor     — reviews capabilities, secrets, exposure, drift.
 *
 * These are *agents*, not kernel code: the design rule is "if a behavior
 * requires judgment, make it a system agent; if it requires deterministic
 * desired-state convergence, make a controller." {@link KubeController} is the
 * deterministic reconciler; system agents are the intelligent operators on top.
 *
 * {@link reconcile} is idempotent: it ensures the system agents + their grants
 * exist in the `hades-system` namespace. Their actual intelligence runs in
 * brain pods (like any agent); here we only bootstrap the resources + grants.
 */
export class SystemAgents {
    static readonly NAMESPACE = "hades-system";
    static readonly NAMES = ["provisioner", "janitor", "auditor"] as const;

    constructor(
        private readonly state: StateStorePort,
        private readonly events: EventStorePort,
    ) {}

    async reconcile(): Promise<void> {
        for (const name of SystemAgents.NAMES) await this.ensureSystemAgent(name);
    }

    /** The capability grant for a system agent (its elevated but scoped powers). */
    static capabilitiesFor(name: string): string[] {
        switch (name) {
            case "provisioner": return ["createAgent", "createHome", "attachListener", "createOwnSchedule", "spawnAgent"];
            case "janitor": return ["deleteExpiredHands", "deleteExpiredRuns", "listResources", "emitArtifact"];
            case "auditor": return ["readPolicy", "listResources", "emitArtifact", "requestApproval"];
            default: return [];
        }
    }

    private async ensureSystemAgent(name: string): Promise<void> {
        const ns = SystemAgents.NAMESPACE;
        const existing = this.state.findByName("Agent", name, ns);
        if (!existing) {
            const agent: HadesResource = {
                apiVersion: "hades.dev/v1alpha1",
                kind: "Agent",
                metadata: { namespace: ns, name },
                spec: {
                    lifecycle: "resident",
                    defaultSession: `${name}-default`,
                    desiredState: "active",
                    brain: { mode: "test" },
                    systemAgent: true,
                    homeRef: `${name}-home`,
                },
                status: { phase: "pending", createdBy: "system" },
            };
            await this.state.apply(agent);
            await this.events.append("system", "system-agent.created", { agent: name, namespace: ns });
        }
        // Ensure the system home.
        if (!this.state.findByName("Home", `${name}-home`, ns)) {
            await this.state.apply({
                apiVersion: "hades.dev/v1alpha1",
                kind: "Home",
                metadata: { namespace: ns, name: `${name}-home` },
                spec: { layout: { create: ["vault", "bin", "reports"] } },
                status: { phase: "pending" },
            });
        }
        // Ensure the elevated (but scoped) capability grant.
        const grantName = `${name}-system-grant`;
        if (!this.state.findByName("CapabilityGrant", grantName, ns)) {
            await this.state.apply({
                apiVersion: "hades.dev/v1alpha1",
                kind: "CapabilityGrant",
                metadata: { namespace: ns, name: grantName },
                spec: {
                    subject: { kind: "Agent", name },
                    capabilities: SystemAgents.capabilitiesFor(name),
                    constraints: { namespace: "own", systemGrant: true },
                },
                status: { phase: "active" },
            });
            await this.events.append("system", "system-agent.granted", { agent: name, capabilities: SystemAgents.capabilitiesFor(name) });
        }
    }
}

/** Re-export for the bootstrapper. */
export { nameOf, namespaceOf };

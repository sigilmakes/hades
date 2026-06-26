import { type HadesResource } from "../domain/resources.js";
import type { StateStorePort } from "../ports/StateStore.js";
import type { EventStorePort } from "../ports/EventStore.js";
import type { PolicyPort } from "../ports/Policy.js";

/**
 * Kernel service for the `Connector` resource — the HTTP capability boundary.
 *
 * A Connector is a deployed userland endpoint the brain may call. The kernel's
 * job is narrow: it stores the declaration, governs egress (a NetworkPolicy is
 * reconciled by the controller), and injects the endpoint into the brain pod
 * env so the brain-side adapter can discover + call it. The kernel never
 * interprets the endpoint body — HTTP is the unifying standard, and the
 * connector itself is userland (swappable, like a Linux device driver).
 *
 * `attachConnector` is the capability-checked syscall an agent uses to wire a
 * new endpoint to itself; operators may apply a Connector manifest directly.
 */
export class ConnectorService {
    constructor(
        private readonly state: StateStorePort,
        private readonly events: EventStorePort,
        private readonly policy: PolicyPort,
    ) {}

    /** List the connectors attached to an agent (for discovery + the UI). */
    forAgent(namespace: string, agentName: string): HadesResource[] {
        return this.state.list("Connector", namespace).filter((c) => c.spec?.agentRef === agentName);
    }

    /**
     * Attach a connector to an agent. Requires the `attachConnector`
     * capability (so an agent can't self-grant egress). Records the
     * declaration; the controller reconciles the NetworkPolicy on the next
     * pass.
     */
    async attach(subject: { kind: string; name?: string; namespace?: string }, spec: Record<string, unknown>): Promise<HadesResource> {
        if (subject.kind !== "Agent") throw new Error("attachConnector: only Agent subjects are supported");
        if (!subject.name || !subject.namespace) throw new Error("attachConnector: subject name + namespace required");
        this.policy.assert({ kind: "Agent", name: subject.name, namespace: subject.namespace }, "attachConnector", { namespace: subject.namespace });
        if (!spec.name) throw new Error("attachConnector requires a name");
        if (!spec.endpoint) throw new Error("attachConnector requires an endpoint URL");
        const connector: HadesResource = {
            apiVersion: "hades.dev/v1alpha1",
            kind: "Connector",
            metadata: { namespace: subject.namespace, name: String(spec.name) },
            spec: {
                agentRef: spec.agentRef ?? subject.name,
                endpoint: String(spec.endpoint),
                ...(spec.secretRef ? { secretRef: String(spec.secretRef) } : {}),
                egress: spec.egress ?? "restricted-web",
            },
            status: { phase: "pending" },
        };
        await this.state.apply(connector);
        await this.events.append("system", "connector.attached", { connector: spec.name, agent: connector.spec?.agentRef, endpoint: spec.endpoint });
        return connector;
    }
}

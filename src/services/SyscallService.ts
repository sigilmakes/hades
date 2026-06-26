import { nameOf, namespaceOf, type AgentSubject, type HadesResource } from "../domain/resources.js";
import type { EventStorePort } from "../ports/EventStore.js";
import type { StateStorePort } from "../ports/StateStore.js";
import { PolicyService } from "./PolicyService.js";

/**
 * The `os.*` syscall layer (spec/08). Agents do not patch raw Kubernetes YAML by
 * default — they call typed Hades syscalls that validate capabilities and write
 * CRDs/events. This is the OS surface: a small, typed, capability-checked API
 * that is the resident agent's main programming model.
 *
 * Each syscall:
 *   1. Resolves the calling subject (must be a real Agent).
 *   2. Asserts the required capability (capability-checked self-modification).
 *   3. Validates namespace boundaries (cannot target another namespace).
 *   4. Writes the resource + appends an audit event.
 *
 * Implemented today: createSchedule, spawnAgent (delegates to the runtime),
 * createAgent, createHome, attachListener, requestApproval, emitArtifact.
 *
 * Approvals are resumable gates (spec/09): requestApproval creates an Approval
 * resource the human (or an authorized agent) responds to; the calling run can
 * await resolution. This is the human-in-the-loop primitive for destructive ops.
 */
export class SyscallService {
    constructor(
        private readonly state: StateStorePort,
        private readonly events: EventStorePort,
        private readonly policy: PolicyService,
    ) {}

    /** os.createAgent — mint a new (usually resident) agent. */
    async createAgent(subject: Partial<AgentSubject>, spec: Record<string, any>): Promise<HadesResource> {
        const resolved = this.policy.resolveAgentSubject(subject);
        this.policy.assert(resolved, "createAgent", { namespace: resolved.namespace });
        if (!spec.name) throw new Error("createAgent requires a name");
        const namespace = this.assertOwnNamespace(spec.namespace, resolved.namespace);
        const agent: HadesResource = {
            apiVersion: "hades.dev/v1alpha1",
            kind: "Agent",
            metadata: { namespace, name: String(spec.name) },
            spec: { lifecycle: spec.lifecycle ?? "resident", defaultSession: spec.defaultSession ?? `${spec.name}-default`, desiredState: spec.desiredState ?? "active", brain: spec.brain ?? { mode: "test" }, homeRef: spec.homeRef },
            status: { phase: "pending", createdBy: resolved.name },
        };
        await this.state.apply(agent);
        await this.audit(resolved, "createAgent", { name: spec.name, namespace });
        return agent;
    }

    /** os.createHome — provision a home PVC for an agent. */
    async createHome(subject: Partial<AgentSubject>, spec: Record<string, any>): Promise<HadesResource> {
        const resolved = this.policy.resolveAgentSubject(subject);
        this.policy.assert(resolved, "createHome", { namespace: resolved.namespace });
        if (!spec.name) throw new Error("createHome requires a name");
        const namespace = this.assertOwnNamespace(spec.namespace, resolved.namespace);
        const home: HadesResource = {
            apiVersion: "hades.dev/v1alpha1",
            kind: "Home",
            metadata: { namespace, name: String(spec.name) },
            spec: { layout: spec.layout, files: spec.files, size: spec.size ?? "1Gi" },
            status: { phase: "pending" },
        };
        await this.state.apply(home);
        await this.audit(resolved, "createHome", { name: spec.name, namespace });
        return home;
    }

    /** os.attachListener — attach a platform listener (discord/email/web/cli) to an agent. */
    async attachListener(subject: Partial<AgentSubject>, spec: Record<string, any>): Promise<HadesResource> {
        const resolved = this.policy.resolveAgentSubject(subject);
        this.policy.assert(resolved, "attachListener", { namespace: resolved.namespace });
        if (!spec.name) throw new Error("attachListener requires a name");
        const namespace = this.assertOwnNamespace(spec.namespace, resolved.namespace);
        const listener: HadesResource = {
            apiVersion: "hades.dev/v1alpha1",
            kind: "Listener",
            metadata: { namespace, name: String(spec.name) },
            spec: { agentRef: spec.agentRef ?? resolved.name, platform: spec.platform ?? "cli", secretRef: spec.secretRef, config: spec.config },
            status: { phase: "pending" },
        };
        await this.state.apply(listener);
        await this.audit(resolved, "attachListener", { name: spec.name, namespace, platform: spec.platform });
        return listener;
    }

    /**
     * os.requestApproval — a resumable gate for destructive/privileged ops
     * (spec/09). Creates an Approval resource the human (or authorized agent)
     * responds to. The calling run may await {@link awaitApproval}.
     */
    async requestApproval(subject: Partial<AgentSubject>, spec: Record<string, any>): Promise<HadesResource> {
        const resolved = this.policy.resolveAgentSubject(subject);
        this.policy.assert(resolved, "requestApproval", { namespace: resolved.namespace });
        if (!spec.name) throw new Error("requestApproval requires a name");
        const namespace = this.assertOwnNamespace(spec.namespace, resolved.namespace);
        const approval: HadesResource = {
            apiVersion: "hades.dev/v1alpha1",
            kind: "Approval",
            metadata: { namespace, name: String(spec.name) },
            spec: { requestedBy: resolved.name, action: spec.action ?? "unspecified", reason: spec.reason, resource: spec.resource, expiresIn: spec.expiresIn ?? "1h" },
            status: { phase: "requested", createdAt: new Date().toISOString() },
        };
        await this.state.apply(approval);
        await this.events.append("system", "approval.requested", { approval: spec.name, by: resolved.name, action: spec.action });
        await this.audit(resolved, "requestApproval", { name: spec.name, action: spec.action });
        return approval;
    }

    /** Respond to an approval (approve/deny). Returns the updated Approval. */
    async respondApproval(subject: Partial<AgentSubject>, name: string, decision: "approve" | "deny", note?: string): Promise<HadesResource> {
        const resolved = this.policy.resolveAgentSubject(subject);
        this.policy.assert(resolved, "respondApproval", { namespace: resolved.namespace });
        const namespace = resolved.namespace;
        const approval = this.state.findByName("Approval", name, namespace);
        if (!approval) throw new Error(`Approval ${namespace}/${name} not found`);
        if (approval.status?.phase !== "requested") throw new Error(`Approval ${name} already ${approval.status?.phase}`);
        approval.status = { ...approval.status, phase: decision === "approve" ? "approved" : "denied", decidedBy: resolved.name, decidedAt: new Date().toISOString(), note };
        await this.state.save();
        await this.events.append("system", "approval.responded", { approval: name, decision, by: resolved.name });
        return approval;
    }

    /** Check whether an approval is approved (resumable-gate read). */
    isApproved(name: string, namespace: string): boolean {
        const approval = this.state.findByName("Approval", name, namespace);
        return approval?.status?.phase === "approved";
    }

    /** os.emitArtifact — record an artifact reference in the event log. */
    async emitArtifact(subject: Partial<AgentSubject>, spec: Record<string, any>): Promise<HadesResource> {
        const resolved = this.policy.resolveAgentSubject(subject);
        this.policy.assert(resolved, "emitArtifact", { namespace: resolved.namespace });
        if (!spec.name) throw new Error("emitArtifact requires a name");
        const namespace = this.assertOwnNamespace(spec.namespace, resolved.namespace);
        const artifact: HadesResource = {
            apiVersion: "hades.dev/v1alpha1",
            kind: "Run",
            metadata: { namespace, name: `artifact-${spec.name}-${Date.now()}` },
            spec: { agentRef: resolved.name, artifactRef: spec.artifactRef, kind: spec.artifactKind ?? "file", summary: spec.summary },
            status: { phase: "emitted", emittedAt: new Date().toISOString() },
        };
        await this.state.apply(artifact);
        await this.events.append(nameOf(artifact), "artifact.emitted", { by: resolved.name, ref: spec.artifactRef });
        await this.audit(resolved, "emitArtifact", { name: spec.name });
        return artifact;
    }

    /** List syscalls an agent is currently permitted (introspection). */
    permittedSyscalls(subject: Partial<AgentSubject>): string[] {
        const resolved = this.policy.resolveAgentSubject(subject);
        const all = ["createSchedule", "spawnAgent", "createAgent", "createHome", "attachListener", "requestApproval", "respondApproval", "emitArtifact"];
        return all.filter((cap) => this.policy.can(resolved, cap, { namespace: resolved.namespace }).allowed);
    }

    private assertOwnNamespace(target: string | undefined, own: string): string {
        if (target && target !== own) throw new Error(`syscall cannot target another namespace: ${target}`);
        return own;
    }

    private async audit(subject: AgentSubject, capability: string, details: Record<string, any>): Promise<void> {
        await this.events.append("system", "syscall.audited", {
            who: `${subject.namespace}/${subject.name}`,
            capability,
            ...details,
        });
    }
}

/** The full catalog of capabilities Hades knows about (for docs/introspection). */
export const CAPABILITIES = [
    "createOwnSchedule",
    "spawnAgent",
    "createAgent",
    "createHome",
    "attachListener",
    "requestApproval",
    "respondApproval",
    "emitArtifact",
    "messageAgent",
    "deleteExpiredHands",
    "deleteExpiredRuns",
    "listResources",
    "readPolicy",
    "readAuditEvents",
    "createFinding",
] as const;

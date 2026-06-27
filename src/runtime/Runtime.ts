import { type AgentSubject, type HadesKind, type HadesResource, type HadesState } from "../domain/resources.js";
import { validateResource } from "../domain/validate.js";
import type { EventStorePort } from "../ports/EventStore.js";
import { type Logger, type Metrics, noopLogger, noopMetrics } from "../ports/Observability.js";
import type { StateStorePort } from "../ports/StateStore.js";
import type { AgentService } from "../services/AgentService.js";
import type { BrainService } from "../services/BrainService.js";
import type { HomeService } from "../services/HomeService.js";
import type { ListenerService } from "../services/ListenerService.js";
import type { MessageService } from "../services/MessageService.js";
import type { PolicyService } from "../services/PolicyService.js";
import type { PrimitiveService } from "../services/PrimitiveService.js";
import type { Reconciler } from "../services/Reconciler.js";
import type { ScheduleService } from "../services/ScheduleService.js";
import type { SyscallService } from "../services/SyscallService.js";
import type { ProjectionService } from "../services/ProjectionService.js";
import type { TemplateService } from "../services/TemplateService.js";
import type { ConnectorService } from "../services/ConnectorService.js";
import type { SkillRegistry } from "../services/SkillRegistry.js";
import type { KubeClient } from "../ports/KubeClient.js";
import type { KubeController } from "../controller/KubeController.js";

/**
 * A Hades runtime — the kernel services wired against stores + ports.
 *
 * Kernel services (Agent/Home/Message/Schedule/Policy/Listener/Reconciler/
 * Syscall/Projection) depend on ports, never on concrete adapters. The
 * composition root ({@link createRuntime}) selects which adapters satisfy
 * the ports: in-process defaults are the test substrate; a live cluster
 * injects pod-backed adapters through the same options.
 *
 * There is no "mode": Hades is one k8s-native kernel. Brains and hands are
 * pods. The in-process adapters exist so the kernel is testable without a
 * cluster — they are test injections, not a peer runtime.
 */

/**
 * Compare two versions of a resource for a meaningful change. Status is
 * runtime-owned (the controller writes it), so it's ignored — only spec
 * and the user-settable metadata (labels/annotations) count as a change.
 */
function specChanged(prev: HadesResource, next: HadesResource): boolean {
    return JSON.stringify(prev.spec ?? {}) !== JSON.stringify(next.spec ?? {});
}

export abstract class Runtime {
    constructor(
        readonly dataDir: string,
        readonly state: StateStorePort,
        readonly events: EventStorePort,
        readonly agents: AgentService,
        readonly brain: BrainService,
        readonly messages: MessageService,
        readonly schedules: ScheduleService,
        readonly primitives: PrimitiveService,
        readonly policy: PolicyService,
        readonly homes: HomeService,
        readonly listeners: ListenerService,
        readonly reconciler: Reconciler,
        readonly syscalls: SyscallService,
        readonly projections: ProjectionService,
        readonly templates: TemplateService,
        readonly connectors: ConnectorService,
        /** The in-tree skill catalog (installable capabilities). */
        readonly skills: SkillRegistry,
        /** Structured logger (default noop — opt-in via the runtime factory). */
        readonly log: Logger = noopLogger,
        /** Kernel self-report metrics (default noop — opt-in via the factory). */
        readonly metrics: Metrics = noopMetrics,
        /** The k8s client, if a live cluster is attached (absent in tests). */
        readonly kubeClient?: KubeClient,
        /** The k8s controller, set by {@link HadesRuntime} when a cluster is attached. */
        protected readonly kubeController?: KubeController,
    ) {}

    abstract init(): Promise<this>;

    /** True once init() has completed and the runtime is ready to serve traffic. */
    ready = false;

    /**
     * Drain in-flight work and release resources (state store handles, the
     * controller watch). Idempotent. Called on SIGTERM so the process exits
     * cleanly within k8s' terminationGracePeriodSeconds instead of being
     * killed mid-write.
     */
    async shutdown(): Promise<void> {
        this.ready = false;
        await this.state.close?.();
        await this.events.close?.();
    }

    /** The k8s controller, if a live cluster is attached (absent in tests). */
    get controller(): KubeController | undefined {
        return this.kubeController;
    }

    async apply(resource: HadesResource): Promise<HadesResource> {
        validateResource(resource);
        const ns = resource.metadata?.namespace ?? "default";
        const name = resource.metadata?.name;
        const existing = name ? this.state.get(resource.kind as HadesKind, ns, name) : undefined;
        const applied = await this.state.apply(resource);
        // Idempotent: only record a resource.applied event when the resource
        // actually changed (spec or labels/annotations). Re-applying an
        // identical manifest is a no-op for the event log, so a controller
        // re-applying desired state doesn't flood the durable log.
        if (!existing || specChanged(existing, applied)) {
            await this.events.append("system", "resource.applied", {
                kind: resource.kind,
                namespace: applied.metadata?.namespace,
                name: applied.metadata?.name,
            });
        }
        return applied;
    }

    /**
     * Remove a resource. Records a `resource.removed` event only if it
     * existed. Returns true if something was deleted.
     */
    async remove(kind: HadesKind, namespace: string, name: string): Promise<boolean> {
        const existed = await this.state.remove(kind, namespace, name);
        if (existed) {
            await this.events.append("system", "resource.removed", { kind, namespace, name });
        }
        return existed;
    }

    async reconcile(): Promise<void> {
        await this.reconciler.reconcile();
    }

    async messageAgent(agentName: string, text: string, options: { namespace?: string; origin?: Record<string, any> } = {}): Promise<{ run: HadesResource; reply: string }> {
        return this.messages.messageAgent(agentName, text, options);
    }

    async createSchedule(subject: Partial<{ kind: "Agent"; name: string; namespace: string }>, spec: Record<string, any>): Promise<HadesResource> {
        return this.schedules.createOwnSchedule(subject, spec);
    }

    /**
     * A resident agent spawns a subordinate agent for a task. By default the
     * subordinate is ephemeral — one prompt, one reply, then reaped. When
     * `spec.lifecycle === "resident"`, the subordinate stays active with its own
     * session and brain pod, and the spawner can send further prompts via
     * `messageAgent` (subject to capability checks). Like a daemon forking a
     * transient vs. a persistent unit.
     *
     * This logic is mode-agnostic: it uses only port-level services. The
     * k8s controller re-targets the *substrate* (the spawned agent becomes a
     * real pod) but this method body is unchanged — the spawn syscall surface
     * is stable.
     */
    async spawnAgent(subject: Partial<AgentSubject>, spec: Record<string, any>): Promise<{ agent: HadesResource; reply: string }> {
        const resolvedSubject = this.policy.resolveAgentSubject(subject);
        this.policy.assert(resolvedSubject, "spawnAgent", { namespace: resolvedSubject.namespace });
        this.policy.assertQuota(resolvedSubject.namespace, "Agent");
        if (!spec.name) throw new Error("spawnAgent requires a name");
        if (spec.namespace && spec.namespace !== resolvedSubject.namespace) {
            throw new Error(`spawnAgent cannot target another namespace: ${spec.namespace}`);
        }
        const namespace = resolvedSubject.namespace;
        const spawnedName = String(spec.name);
        const lifecycle = spec.lifecycle === "resident" ? "resident" : "ephemeral";
        if (this.state.findByName("Agent", spawnedName, namespace)) {
            throw new Error(`Agent ${namespace}/${spawnedName} already exists`);
        }
        const capabilities: string[] = Array.isArray(spec.capabilities) ? spec.capabilities : [];
        const spawned: HadesResource = {
            apiVersion: "hades.dev/v1alpha1",
            kind: "Agent",
            metadata: { namespace, name: spawnedName },
            spec: {
                lifecycle,
                defaultSession: `${spawnedName}-default`,
                desiredState: "active",
                brain: { mode: spec.brain?.mode ?? "test", ...(spec.brain?.image ? { image: spec.brain.image } : {}) },
            },
            status: { phase: "pending", spawnedBy: resolvedSubject.name },
        };
        await this.state.apply(spawned);
        await this.events.append("system", "agent.spawned", { agent: spawnedName, by: resolvedSubject.name, namespace, lifecycle });
        if (capabilities.length > 0) {
            await this.state.apply({
                apiVersion: "hades.dev/v1alpha1",
                kind: "CapabilityGrant",
                metadata: { namespace, name: `${spawnedName}-spawn-grant` },
                spec: { subject: { kind: "Agent", name: spawnedName }, capabilities, constraints: { namespace: "own" } },
                status: { phase: "active" },
            });
        }
        await this.reconcile();
        let reply = "";
        const grantName = capabilities.length > 0 ? `${spawnedName}-spawn-grant` : undefined;
        try {
            reply = (await this.messages.messageAgent(spawnedName, String(spec.prompt ?? ""), { namespace })).reply;
        } finally {
            // Ephemeral subordinates are reaped after the prompt; resident
            // subordinates stay active so the spawner can keep talking to them.
            if (lifecycle === "ephemeral") {
                const reaped = this.state.findByName("Agent", spawnedName, namespace);
                if (reaped) {
                    reaped.status = { ...(reaped.status ?? {}), phase: "completed", reapedAt: new Date().toISOString() };
                    await this.state.save();
                    await this.events.append("system", "agent.reaped", { agent: spawnedName, namespace, by: resolvedSubject.name });
                }
                if (grantName) {
                    await this.state.remove("CapabilityGrant", namespace, grantName);
                }
            }
        }
        return { agent: this.state.findByName("Agent", spawnedName, namespace) ?? spawned, reply };
    }

    /**
     * Install a catalog skill onto an agent: resolve a known catalog entry
     * into a live `Skill` CRD (the kernel routes a Service to the brain pod)
     * plus a `CapabilityGrant` so the agent may serve it. Mirrors `hades new`
     * resolving a template — the catalog is discovery data, install creates
     * the governed resources. The skill *body* stays userland (the catalog's
     * image); the kernel only routes + governs.
     *
     * Throws if the skill isn't in the catalog (unknown capability) or the
     * subject lacks the `publishSkill` capability.
     */
    async installSkill(subject: Partial<AgentSubject>, skillName: string, options: { agentRef?: string; namespace?: string } = {}): Promise<{ skill: HadesResource }> {
        const resolved = this.policy.resolveAgentSubject(subject);
        const entry = this.skills.find(skillName);
        if (!entry) throw new Error(`Unknown skill '${skillName}'. Cataloged: ${this.skills.list().map((e) => e.name).join(", ")}`);
        const agentRef = options.agentRef ?? resolved.name;
        const namespace = options.namespace ?? resolved.namespace;
        const skill: HadesResource = {
            apiVersion: "hades.dev/v1alpha1",
            kind: "Skill",
            metadata: { namespace, name: `${agentRef}-${skillName}` },
            spec: { agentRef, port: entry.port, ...(entry.path ? { path: entry.path } : {}), description: entry.description, image: entry.image, catalog: skillName },
            status: { phase: "pending" },
        };
        await this.apply(skill);
        await this.events.append("system", "skill.installed", { skill: skill.metadata!.name, agent: agentRef, catalog: skillName });
        return { skill };
    }

    async snapshot(): Promise<HadesState> {
        return this.state.state;
    }
}

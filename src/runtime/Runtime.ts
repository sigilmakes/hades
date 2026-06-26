import { type AgentSubject, type HadesResource, type HadesState, nameOf, namespaceOf } from "../domain/resources.js";
import type { EventStorePort } from "../ports/EventStore.js";
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

/**
 * A Hades runtime — the kernel services wired against stores + ports.
 *
 * Both {@link LocalRuntime} (dev, in-process adapters) and the deploy runtime
 * (pod-backed adapters behind the same ports) inherit this shape. Kernel
 * services (Agent/Home/Message/Schedule/Policy/Listener/Reconciler) are
 * mode-agnostic: they depend on ports, never on concrete adapters. The mode
 * only changes which adapters satisfy the ports.
 *
 * This formalizes the dev/deploy mode split (D4): the simulation and the
 * distributed operator share one kernel; only the substrate differs.
 */
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
    ) {}

    /** A label for which substrate is active: "local" or "distributed". */
    abstract readonly mode: "local" | "distributed";

    abstract init(): Promise<this>;

    async apply(resource: HadesResource): Promise<HadesResource> {
        const applied = await this.state.apply(resource);
        await this.events.append("system", "resource.applied", {
            kind: resource.kind,
            namespace: applied.metadata?.namespace,
            name: applied.metadata?.name,
        });
        return applied;
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
     * A resident agent spawns a throwaway (ephemeral) agent for one task.
     * The kernel checks the `spawnAgent` capability, mints a confined ephemeral
     * agent in the caller's namespace, runs the prompt once, reaps it, and
     * returns the reply. Like a daemon forking a transient unit.
     *
     * This logic is mode-agnostic: it uses only port-level services. P6
     * re-targets the *substrate* (the spawned agent becomes a real pod) but
     * this method body is unchanged — the spawn syscall surface is stable.
     */
    async spawnAgent(subject: Partial<AgentSubject>, spec: Record<string, any>): Promise<{ agent: HadesResource; reply: string }> {
        const resolvedSubject = this.policy.resolveAgentSubject(subject);
        this.policy.assert(resolvedSubject, "spawnAgent", { namespace: resolvedSubject.namespace });
        if (!spec.name) throw new Error("spawnAgent requires a name");
        if (spec.namespace && spec.namespace !== resolvedSubject.namespace) {
            throw new Error(`spawnAgent cannot target another namespace: ${spec.namespace}`);
        }
        const namespace = resolvedSubject.namespace;
        const ephemeralName = String(spec.name);
        if (this.state.findByName("Agent", ephemeralName, namespace)) {
            throw new Error(`Agent ${namespace}/${ephemeralName} already exists`);
        }
        const capabilities: string[] = Array.isArray(spec.capabilities) ? spec.capabilities : [];
        const ephemeral: HadesResource = {
            apiVersion: "hades.dev/v1alpha1",
            kind: "Agent",
            metadata: { namespace, name: ephemeralName },
            spec: {
                lifecycle: "ephemeral",
                defaultSession: `${ephemeralName}-default`,
                desiredState: "active",
                brain: { mode: spec.brain?.mode ?? "test" },
            },
            status: { phase: "pending", spawnedBy: resolvedSubject.name },
        };
        await this.state.apply(ephemeral);
        await this.events.append("system", "agent.spawned", { agent: ephemeralName, by: resolvedSubject.name, namespace });
        if (capabilities.length > 0) {
            await this.state.apply({
                apiVersion: "hades.dev/v1alpha1",
                kind: "CapabilityGrant",
                metadata: { namespace, name: `${ephemeralName}-spawn-grant` },
                spec: { subject: { kind: "Agent", name: ephemeralName }, capabilities, constraints: { namespace: "own" } },
                status: { phase: "active" },
            });
        }
        await this.reconcile();
        let reply = "";
        const grantName = capabilities.length > 0 ? `${ephemeralName}-spawn-grant` : undefined;
        try {
            reply = (await this.messages.messageAgent(ephemeralName, String(spec.prompt ?? ""), { namespace })).reply;
        } finally {
            const reaped = this.state.findByName("Agent", ephemeralName, namespace);
            if (reaped) {
                reaped.status = { ...(reaped.status ?? {}), phase: "completed", reapedAt: new Date().toISOString() };
                await this.state.save();
                await this.events.append("system", "agent.reaped", { agent: ephemeralName, namespace, by: resolvedSubject.name });
            }
            if (grantName) {
                await this.state.remove("CapabilityGrant", namespace, grantName);
            }
        }
        return { agent: this.state.findByName("Agent", ephemeralName, namespace) ?? ephemeral, reply };
    }

    async snapshot(): Promise<HadesState> {
        return this.state.state;
    }
}

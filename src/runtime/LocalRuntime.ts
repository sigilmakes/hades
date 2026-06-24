import { type AgentSubject, type HadesResource, type HadesState, nameOf, namespaceOf } from "../domain/resources.js";
import { JsonlEventStore } from "../adapters/store/JsonlEventStore.js";
import { JsonStateStore } from "../adapters/store/JsonStateStore.js";
import { LocalConfinedHands } from "../adapters/hands/LocalConfinedHands.js";
import { PiSdkBrainDriver } from "../adapters/brain/PiSdkBrainDriver.js";
import { TestBrainDriver } from "../adapters/brain/TestBrainDriver.js";
import { AgentService } from "../services/AgentService.js";
import { BrainService, type BrainMode } from "../services/BrainService.js";
import { HomeService } from "../services/HomeService.js";
import { ListenerService } from "../services/ListenerService.js";
import { MessageService } from "../services/MessageService.js";
import { PolicyService } from "../services/PolicyService.js";
import { PrimitiveService } from "../services/PrimitiveService.js";
import { Reconciler } from "../services/Reconciler.js";
import { ScheduleService } from "../services/ScheduleService.js";

export type SpawnResult = { agent: HadesResource; reply: string };

export class LocalRuntime {
    constructor(
        readonly dataDir: string,
        readonly state: JsonStateStore,
        readonly events: JsonlEventStore,
        readonly agents: AgentService,
        readonly brain: BrainService,
        readonly messages: MessageService,
        readonly schedules: ScheduleService,
        readonly primitives: PrimitiveService,
        private readonly policy: PolicyService,
        private readonly reconciler: Reconciler,
    ) {}

    async init(): Promise<this> {
        await this.state.init();
        await this.events.init();
        return this;
    }

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

    async createSchedule(subject: Partial<AgentSubject>, spec: Record<string, any>): Promise<HadesResource> {
        return this.schedules.createOwnSchedule(subject, spec);
    }

    /**
     * A resident agent spawns a throwaway (ephemeral) agent for one task.
     * The kernel checks the `spawnAgent` capability, mints a confined ephemeral
     * agent in the caller's namespace, runs the prompt once, reaps it, and
     * returns the reply. Like a daemon forking a transient unit.
     */
    async spawnAgent(subject: Partial<AgentSubject>, spec: Record<string, any>): Promise<SpawnResult> {
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
        // Optional narrow capability grant for the ephemeral worker.
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
        const { reply } = await this.messages.messageAgent(ephemeralName, String(spec.prompt ?? ""), { namespace });
        const reaped = this.state.findByName("Agent", ephemeralName, namespace);
        if (reaped) {
            reaped.status = { ...(reaped.status ?? {}), phase: "completed", reapedAt: new Date().toISOString() };
            await this.state.save();
        }
        await this.events.append("system", "agent.reaped", { agent: ephemeralName, namespace });
        return { agent: ephemeral, reply };
    }

    async snapshot(): Promise<HadesState> {
        return this.state.state;
    }
}

export function createRuntime(dataDir: string): LocalRuntime {
    const state = new JsonStateStore(dataDir);
    const events = new JsonlEventStore(dataDir);
    const agents = new AgentService(dataDir, state, events);
    const policy = new PolicyService(state);
    const schedules = new ScheduleService(state, events, policy);
    const handsFor = (agent: HadesResource, session: HadesResource) => new LocalConfinedHands({
        homeRoot: agents.homeRoot(agent),
        events,
        sessionId: nameOf(session),
    });
    let runtime: LocalRuntime;
    const brain = new BrainService(events, (mode: BrainMode) => {
        if (mode === "pi-sdk") return new PiSdkBrainDriver(events, (agent) => agents.homeRoot(agent), handsFor);
        return new TestBrainDriver(events, handsFor, schedules, (subject, spec) => runtime.spawnAgent(subject, spec));
    });
    const messages = new MessageService(state, events, agents, brain);
    const homes = new HomeService(dataDir, state, events);
    const listeners = new ListenerService(state, events);
    const primitives = new PrimitiveService();
    const reconciler = new Reconciler(state, homes, agents, listeners, schedules, messages);
    runtime = new LocalRuntime(dataDir, state, events, agents, brain, messages, schedules, primitives, policy, reconciler);
    return runtime;
}
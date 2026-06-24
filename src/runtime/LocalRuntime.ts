import { type AgentSubject, type HadesResource, type HadesState } from "../domain/resources.js";
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
import { Reconciler } from "../services/Reconciler.js";
import { ScheduleService } from "../services/ScheduleService.js";
import { nameOf } from "../domain/resources.js";

export class LocalRuntime {
    constructor(
        readonly dataDir: string,
        readonly state: JsonStateStore,
        readonly events: JsonlEventStore,
        readonly agents: AgentService,
        readonly brain: BrainService,
        readonly messages: MessageService,
        readonly schedules: ScheduleService,
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
    const brain = new BrainService(events, (mode: BrainMode) => {
        if (mode === "pi-sdk") return new PiSdkBrainDriver(events, (agent) => agents.homeRoot(agent), handsFor);
        return new TestBrainDriver(events, handsFor, schedules);
    });
    const messages = new MessageService(state, events, agents, brain);
    const homes = new HomeService(dataDir, state, events);
    const listeners = new ListenerService(state, events);
    const reconciler = new Reconciler(state, homes, agents, listeners, schedules, messages);
    return new LocalRuntime(dataDir, state, events, agents, brain, messages, schedules, reconciler);
}

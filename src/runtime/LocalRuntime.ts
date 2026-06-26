import { type HadesResource, type HadesState, nameOf, namespaceOf } from "../domain/resources.js";
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
import { SyscallService } from "../services/SyscallService.js";
import { SystemAgents } from "../services/SystemAgents.js";
import { ProjectionService } from "../services/ProjectionService.js";
import { Runtime } from "./Runtime.js";
import type { HandsResolver } from "../ports/HandsResolver.js";
import type { BrainDriver } from "../ports/BrainDriver.js";
import type { HandsBackend } from "../ports/HandsBackend.js";

export type SpawnResult = { agent: HadesResource; reply: string };

/**
 * The dev-mode runtime: a single-process kernel with in-process adapters.
 *
 * This is the proven simulation. All squishy workloads (brain, hands) are
 * in-process objects the kernel manages. Durable state is JSON + JSONL on disk.
 *
 * Code written against the shared {@link Runtime} services does not change when
 * the workloads become pods in the distributed mode — the ports are the seam.
 */
export class LocalRuntime extends Runtime {
    override readonly mode = "local" as const;

    constructor(
        override readonly dataDir: string,
        override readonly state: JsonStateStore,
        override readonly events: JsonlEventStore,
        override readonly agents: AgentService,
        override readonly brain: BrainService,
        override readonly messages: MessageService,
        override readonly schedules: ScheduleService,
        override readonly primitives: PrimitiveService,
        override readonly policy: PolicyService,
        override readonly reconciler: Reconciler,
        override readonly homes: HomeService,
        override readonly listeners: ListenerService,
        override readonly syscalls: SyscallService,
        override readonly projections: ProjectionService,
    ) {
        super(dataDir, state, events, agents, brain, messages, schedules, primitives, policy, homes, listeners, reconciler, syscalls, projections);
    }

    override async init(): Promise<this> {
        await this.state.init();
        await this.events.init();
        return this;
    }
}

/**
 * A {@link HandsResolver} that returns an in-process {@link LocalConfinedHands}
 * bound to the agent's local home directory. This is the dev-mode resolver.
 */
class LocalHandsResolver implements HandsResolver {
    constructor(private readonly agents: AgentService, private readonly events: JsonlEventStore) {}

    for(agent: HadesResource, session: HadesResource): LocalConfinedHands {
        return new LocalConfinedHands({
            homeRoot: this.agents.homeRoot(agent),
            events: this.events,
            sessionId: nameOf(session),
        });
    }
}

export function createRuntime(dataDir: string): LocalRuntime {
    const state = new JsonStateStore(dataDir);
    const events = new JsonlEventStore(dataDir);
    const agents = new AgentService(dataDir, state, events);
    const policy = new PolicyService(state);
    const schedules = new ScheduleService(state, events, policy);
    const handsResolver = new LocalHandsResolver(agents, events);
    let runtime: LocalRuntime;
    const brain = new BrainService(events, (mode: BrainMode) => {
        if (mode === "pi-sdk") return new PiSdkBrainDriver(events, (agent) => agents.homeRoot(agent), (a, s) => handsResolver.for(a, s));
        return new TestBrainDriver(events, (a, s) => handsResolver.for(a, s), schedules, (subject, spec) => runtime.spawnAgent(subject, spec));
    });
    const messages = new MessageService(state, events, agents, brain);
    const homes = new HomeService(dataDir, state, events);
    const listeners = new ListenerService(state, events);
    const primitives = new PrimitiveService();
    const reconciler = new Reconciler(state, homes, agents, listeners, schedules, messages, new SystemAgents(state, events));
    const syscalls = new SyscallService(state, events, policy);
    const projections = new ProjectionService(state, events);
    runtime = new LocalRuntime(dataDir, state, events, agents, brain, messages, schedules, primitives, policy, reconciler, homes, listeners, syscalls, projections);
    return runtime;
}

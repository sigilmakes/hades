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
import { LocalConfinedHands } from "../adapters/hands/LocalConfinedHands.js";
import { PiSdkBrainDriver } from "../adapters/brain/PiSdkBrainDriver.js";
import { TestBrainDriver } from "../adapters/brain/TestBrainDriver.js";
import { HttpBrainDriver } from "../adapters/brain/HttpBrainDriver.js";
import { KubeController } from "../controller/KubeController.js";
import { Runtime } from "./Runtime.js";
import type { BrainDriver } from "../ports/BrainDriver.js";
import type { HandsResolver } from "../ports/HandsResolver.js";
import type { StateStorePort } from "../ports/StateStore.js";
import type { EventStorePort } from "../ports/EventStore.js";
import type { KubeClient } from "../ports/KubeClient.js";
import { nameOf, type HadesResource } from "../domain/resources.js";

/**
 * The Hades runtime — the kernel services wired against stores + ports, plus the
 * composition root that selects which adapters satisfy those ports.
 *
 * Kernel services (Agent/Home/Message/Schedule/Policy/Listener/Reconciler/
 * Syscall/Projection) depend on ports, never on concrete adapters. The factory
 * below is the only place that chooses adapters: the in-process defaults are
 * the test/dev substrate; a live cluster injects pod-backed adapters
 * (HTTP/MCP clients, the real k8s client) through the same options.
 *
 * There is no "mode": Hades is one k8s-native kernel. Brains and hands are
 * pods. The in-process adapters exist so the kernel is testable without a
 * cluster — they are test injections, not a peer runtime.
 */
export class HadesRuntime extends Runtime {
    constructor(
        override readonly dataDir: string,
        override readonly state: StateStorePort,
        override readonly events: EventStorePort,
        override readonly agents: AgentService,
        override readonly brain: BrainService,
        override readonly messages: MessageService,
        override readonly schedules: ScheduleService,
        override readonly primitives: PrimitiveService,
        override readonly policy: PolicyService,
        override readonly homes: HomeService,
        override readonly listeners: ListenerService,
        override readonly reconciler: Reconciler,
        override readonly syscalls: SyscallService,
        override readonly projections: ProjectionService,
        override readonly kubeClient?: KubeClient,
    ) {
        super(dataDir, state, events, agents, brain, messages, schedules, primitives, policy, homes, listeners, reconciler, syscalls, projections, kubeClient, kubeClient ? new KubeController(state, events, kubeClient) : undefined);
    }

    override async init(): Promise<this> {
        await this.state.init();
        await this.events.init();
        // Start the projection store: replay the durable log + subscribe.
        await this.projections.start();
        return this;
    }

    override async reconcile(): Promise<void> {
        await super.reconcile();
        if (this.kubeController) await this.kubeController.reconcile();
    }
}

/**
 * Construct a Hades runtime. Kernel services are wired against the injected (or
 * default) stores and brain-driver factory. Pass a {@link KubeClient} to run
 * the k8s controller — the real cluster client in deploy, a fake in tests.
 *
 * Defaults use the in-process adapters so the kernel is exercisable without a
 * cluster. A live cluster injects `kubeClient` (and overrides the brain/hands
 * resolvers) through the same options.
 */
export async function createRuntime(dataDir: string, options: RuntimeOptions = {}): Promise<HadesRuntime> {
    const state = options.stateStore ?? (await loadSqliteStateStore(dataDir));
    const events = options.eventStore ?? (await loadSqliteEventStore(dataDir));
    const agents = new AgentService(dataDir, state, events);
    const policy = new PolicyService(state);
    const schedules = new ScheduleService(state, events, policy);
    const handsResolver = options.handsResolver ?? new InProcessHandsResolver(agents, events);
    let runtime: HadesRuntime;
    const brainFactory = options.brainDriverFactory ?? defaultBrainFactory(events, agents, handsResolver, schedules, () => runtime);
    const brain = new BrainService(events, brainFactory);
    const messages = new MessageService(state, events, agents, brain);
    const homes = new HomeService(dataDir, state, events);
    const listeners = new ListenerService(state, events);
    const primitives = new PrimitiveService();
    const reconciler = new Reconciler(state, homes, agents, listeners, schedules, messages, new SystemAgents(state, events));
    const syscalls = new SyscallService(state, events, policy);
    const projections = new ProjectionService(state, events);
    runtime = new HadesRuntime(dataDir, state, events, agents, brain, messages, schedules, primitives, policy, homes, listeners, reconciler, syscalls, projections, options.kubeClient);
    return runtime;
}

export type RuntimeOptions = {
    stateStore?: StateStorePort;
    eventStore?: EventStorePort;
    brainDriverFactory?: (mode: BrainMode) => BrainDriver;
    handsResolver?: HandsResolver;
    kubeClient?: KubeClient;
};

/**
 * The default hands resolver: an in-process {@link LocalConfinedHands} bound to
 * the agent's local home directory. The test substrate — a live cluster
 * injects a pod-backed resolver instead.
 */
class InProcessHandsResolver implements HandsResolver {
    constructor(private readonly agents: AgentService, private readonly events: EventStorePort) {}

    for(agent: HadesResource, session: HadesResource): LocalConfinedHands {
        return new LocalConfinedHands({
            homeRoot: this.agents.homeRoot(agent),
            events: this.events,
            sessionId: nameOf(session),
        });
    }
}

/**
 * The default brain factory. Routes to a brain pod via `HttpBrainDriver` when
 * `HADES_BRAIN_URL` is set; otherwise uses the in-process pi-SDK / test drivers
 * so the kernel is exercisable without a pod.
 */
function defaultBrainFactory(
    events: EventStorePort,
    agents: AgentService,
    handsResolver: HandsResolver,
    schedules: ScheduleService,
    runtime: () => HadesRuntime,
): (mode: BrainMode) => BrainDriver {
    const brainUrl = process.env.HADES_BRAIN_URL;
    if (brainUrl) return () => new HttpBrainDriver(brainUrl);
    return (mode: BrainMode) => {
        if (mode === "pi-sdk") return new PiSdkBrainDriver(events, (agent) => agents.homeRoot(agent), (a, s) => handsResolver.for(a, s));
        return new TestBrainDriver(events, (a, s) => handsResolver.for(a, s), schedules, (subject, spec) => runtime().spawnAgent(subject, spec));
    };
}

/** Lazy-load the sqlite state store so `node:sqlite` isn't pulled into processes that don't use it. */
async function loadSqliteStateStore(dataDir: string): Promise<StateStorePort> {
    const { SqliteStateStore } = await import("../adapters/store/SqliteStateStore.js");
    return new SqliteStateStore(dataDir);
}

/** Lazy-load the sqlite event store so `node:sqlite` isn't pulled into processes that don't use it. */
async function loadSqliteEventStore(dataDir: string): Promise<EventStorePort> {
    const { SqliteEventStore } = await import("../adapters/store/SqliteEventStore.js");
    return new SqliteEventStore(dataDir);
}

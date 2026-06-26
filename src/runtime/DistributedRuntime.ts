import { AgentService } from "../services/AgentService.js";
import { BrainService, type BrainMode } from "../services/BrainService.js";
import { HomeService } from "../services/HomeService.js";
import { ListenerService } from "../services/ListenerService.js";
import { MessageService } from "../services/MessageService.js";
import { PolicyService } from "../services/PolicyService.js";
import { PrimitiveService } from "../services/PrimitiveService.js";
import { Reconciler } from "../services/Reconciler.js";
import { ScheduleService } from "../services/ScheduleService.js";
import { LocalConfinedHands } from "../adapters/hands/LocalConfinedHands.js";
import { PiSdkBrainDriver } from "../adapters/brain/PiSdkBrainDriver.js";
import { TestBrainDriver } from "../adapters/brain/TestBrainDriver.js";
import { HttpBrainDriver } from "../adapters/brain/HttpBrainDriver.js";
import { SqliteEventStore } from "../adapters/store/SqliteEventStore.js";
import { SqliteStateStore } from "../adapters/store/SqliteStateStore.js";
import { Runtime } from "./Runtime.js";
import type { BrainDriver } from "../ports/BrainDriver.js";
import type { HandsResolver } from "../ports/HandsResolver.js";
import type { StateStorePort } from "../ports/StateStore.js";
import type { EventStorePort } from "../ports/EventStore.js";
import type { KubeClient } from "../ports/KubeClient.js";
import { KubeController } from "../controller/KubeController.js";
import type { HadesResource } from "../domain/resources.js";
import { nameOf } from "../domain/resources.js";

/**
 * Error raised by deploy-mode adapters that have not been wired yet. Kept so
 * tests and the P1–P4 work can assert the stub shape; the default distributed
 * runtime in P0 uses dev adapters to prove the shared kernel, so this is only
 * thrown when an adapter is explicitly injected as a stub.
 */
export class NotImplementedError extends Error {
    readonly feature: string;
    constructor(feature: string) {
        super(`Hades distributed adapter not implemented: ${feature}. (P0 seam only — fill in during P1–P4.)`);
        this.name = "NotImplementedError";
        this.feature = feature;
    }
}

/**
 * The deploy-mode runtime: the same kernel as {@link LocalRuntime} but with
 * pod-backed adapters behind the same ports (D4). When a {@link KubeClient} is
 * provided, reconcile also runs the {@link KubeController} to ensure native k8s
 * objects (Deployments for brains, PVCs for homes, CronJobs for schedules) —
 * the deploy-mode equivalent of the in-process {@link Reconciler}.
 *
 * Constructed by `hades controller` (see the CLI).
 */
export class DistributedRuntime extends Runtime {
    override readonly mode = "distributed" as const;
    private readonly kubeController?: KubeController;

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
        kubeClient?: KubeClient,
    ) {
        super(dataDir, state, events, agents, brain, messages, schedules, primitives, policy, homes, listeners, reconciler);
        this.kubeController = kubeClient ? new KubeController(state, events, kubeClient) : undefined;
    }

    override async init(): Promise<this> {
        await this.state.init();
        await this.events.init();
        return this;
    }

    override async reconcile(): Promise<void> {
        await super.reconcile();
        if (this.kubeController) await this.kubeController.reconcile();
    }
}

/**
 * Construct a deploy-mode runtime. P0: kernel services are wired against the
 * dev-mode stores/brain so the shared kernel is testable end-to-end; each
 * subsequent phase swaps a stub adapter for a real pod-backed one.
 *
 * Inject `brainDriverFactory`/`handsResolver`/`stateStore`/`eventStore` to
 * replace the defaults as phases land.
 */
export async function createDistributedRuntime(dataDir: string, options: DistributedRuntimeOptions = {}): Promise<DistributedRuntime> {
    const state = options.stateStore ?? (await loadSqliteStateStore(dataDir));
    const events = options.eventStore ?? (await loadSqliteEventStore(dataDir));
    const agents = new AgentService(dataDir, state, events);
    const policy = new PolicyService(state);
    const schedules = new ScheduleService(state, events, policy);
    const handsResolver = options.handsResolver ?? new LocalHandsResolverAdapter(agents, events);
    let runtime: DistributedRuntime;
    const brainFactory = options.brainDriverFactory ?? defaultDistributedBrainFactory(events, agents, handsResolver, schedules, () => runtime);
    const brain = new BrainService(events, brainFactory);
    const messages = new MessageService(state, events, agents, brain);
    const homes = new HomeService(dataDir, state, events);
    const listeners = new ListenerService(state, events);
    const primitives = new PrimitiveService();
    const reconciler = new Reconciler(state, homes, agents, listeners, schedules, messages);
    runtime = new DistributedRuntime(dataDir, state, events, agents, brain, messages, schedules, primitives, policy, homes, listeners, reconciler, options.kubeClient);
    return runtime;
}

/** Bridge a `HandsResolver` onto the dev `LocalConfinedHands` adapter. */
class LocalHandsResolverAdapter implements HandsResolver {
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
 * Default brain factory for the distributed runtime.
 *
 * - If `HADES_BRAIN_URL` is set, route to a real brain pod via `HttpBrainDriver`
 *   (P1: the parent→brain wire). The pod owns the model loop.
 * - Otherwise fall back to the dev adapters so the shared kernel is testable
 *   end-to-end without a pod. P1 tests that exercise the HTTP path set the env.
 */
function defaultDistributedBrainFactory(
    events: EventStorePort,
    agents: AgentService,
    handsResolver: HandsResolver,
    schedules: ScheduleService,
    runtime: () => DistributedRuntime,
): (mode: BrainMode) => BrainDriver {
    const brainUrl = process.env.HADES_BRAIN_URL;
    if (brainUrl) return () => new HttpBrainDriver(brainUrl);
    return (mode: BrainMode) => {
        if (mode === "pi-sdk") return new PiSdkBrainDriver(events, (agent) => agents.homeRoot(agent), (a, s) => handsResolver.for(a, s));
        return new TestBrainDriver(events, (a, s) => handsResolver.for(a, s), schedules, (subject, spec) => runtime().spawnAgent(subject, spec));
    };
}

export type DistributedRuntimeOptions = {
    stateStore?: StateStorePort;
    eventStore?: EventStorePort;
    brainDriverFactory?: (mode: BrainMode) => BrainDriver;
    handsResolver?: HandsResolver;
    kubeClient?: KubeClient;
};

/** Lazy-load the sqlite state store so `node:sqlite` isn't pulled into processes that don't use it (e.g. brain-pod tests). */
async function loadSqliteStateStore(dataDir: string): Promise<StateStorePort> {
    const { SqliteStateStore } = await import("../adapters/store/SqliteStateStore.js");
    return new SqliteStateStore(dataDir);
}

/** Lazy-load the sqlite event store so `node:sqlite` isn't pulled into processes that don't use it. */
async function loadSqliteEventStore(dataDir: string): Promise<EventStorePort> {
    const { SqliteEventStore } = await import("../adapters/store/SqliteEventStore.js");
    return new SqliteEventStore(dataDir);
}

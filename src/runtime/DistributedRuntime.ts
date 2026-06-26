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
import { JsonStateStore } from "../adapters/store/JsonStateStore.js";
import { JsonlEventStore } from "../adapters/store/JsonlEventStore.js";
import { Runtime } from "./Runtime.js";
import type { BrainDriver } from "../ports/BrainDriver.js";
import type { HandsResolver } from "../ports/HandsResolver.js";
import type { StateStorePort } from "../ports/StateStore.js";
import type { EventStorePort } from "../ports/EventStore.js";
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
 * pod-backed adapters behind the same ports (D4). In P0 the default adapters
 * are the dev ones so the shared kernel is testable end-to-end; each
 * subsequent phase swaps a stub adapter for a real pod-backed one via
 * {@link createDistributedRuntime} options.
 *
 * Constructed by `hades controller` (see the CLI).
 */
export class DistributedRuntime extends Runtime {
    override readonly mode = "distributed" as const;

    override async init(): Promise<this> {
        await this.state.init();
        await this.events.init();
        return this;
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
export function createDistributedRuntime(dataDir: string, options: DistributedRuntimeOptions = {}): DistributedRuntime {
    const state = options.stateStore ?? new JsonStateStore(dataDir);
    const events = options.eventStore ?? new JsonlEventStore(dataDir);
    const agents = new AgentService(dataDir, state, events);
    const policy = new PolicyService(state);
    const schedules = new ScheduleService(state, events, policy);
    const handsResolver = options.handsResolver ?? new LocalHandsResolverAdapter(agents, events);
    let runtime: DistributedRuntime;
    const brainFactory = options.brainDriverFactory ?? ((mode: BrainMode) => {
        if (mode === "pi-sdk") return new PiSdkBrainDriver(events, (agent) => agents.homeRoot(agent), (a, s) => handsResolver.for(a, s));
        return new TestBrainDriver(events, (a, s) => handsResolver.for(a, s), schedules, (subject, spec) => runtime.spawnAgent(subject, spec));
    });
    const brain = new BrainService(events, brainFactory);
    const messages = new MessageService(state, events, agents, brain);
    const homes = new HomeService(dataDir, state, events);
    const listeners = new ListenerService(state, events);
    const primitives = new PrimitiveService();
    const reconciler = new Reconciler(state, homes, agents, listeners, schedules, messages);
    runtime = new DistributedRuntime(dataDir, state, events, agents, brain, messages, schedules, primitives, policy, homes, listeners, reconciler);
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

export type DistributedRuntimeOptions = {
    stateStore?: StateStorePort;
    eventStore?: EventStorePort;
    brainDriverFactory?: (mode: BrainMode) => BrainDriver;
    handsResolver?: HandsResolver;
};

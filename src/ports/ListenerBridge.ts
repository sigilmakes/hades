import type { HadesResource } from "../domain/resources.js";

/**
 * A listener bridge: the gateway/driver that connects a platform (Discord,
 * Matrix, email, web, CLI) to a Hades agent (docs/listeners.md). Listeners are per-agent
 * I/O devices — *not* tools. A bridge receives inbound messages and routes
 * them to the agent's session; replies default to the inbound origin.
 *
 * This port is the contract every platform bridge satisfies. A {@link CliBridge}
 * is the proven, testable implementation; Discord/Matrix/email bridges are
 * adapters behind the same port (their platform SDKs are the only difference).
 *
 * Listener pods are cattle: if a bridge crashes, the agent and session persist.
 * The bridge is a thin adapter that turns platform events into Hades
 * `listener.message.received` events and routes brain replies back.
 */
export interface ListenerBridge {
    readonly platform: string;
    /** Start the bridge (connect to the platform). */
    start(): Promise<void>;
    /** Stop the bridge. */
    stop(): Promise<void>;
    /** Send an outbound reply to a platform target (channel/user/thread). */
    send(target: string, text: string): Promise<void>;
}

/** The inbound message shape a bridge produces (docs/listeners.md). */
export type InboundMessage = {
    listenerRef: string;
    agentRef: string;
    sessionRef: string;
    origin: {
        platform: string;
        channel: string;
        sender?: string;
        thread?: string | null;
    };
    content: string;
};

/** A deliver function: the bridge calls this with inbound messages; it routes to the agent. */
export type DeliverInbound = (message: InboundMessage) => Promise<{ reply: string; origin: InboundMessage["origin"] }>;

/**
 * A CLI listener bridge: routes stdin lines to an agent and prints replies to
 * stdout. The simplest real bridge — proves the listener contract end-to-end
 * without a platform SDK. Used by `hades attach <agent>` for a kernel console.
 */
export class CliBridge implements ListenerBridge {
    readonly platform = "cli";
    private deliver?: DeliverInbound;
    private running = false;

    constructor(
        private readonly listenerRef: string,
        private readonly agentRef: string,
        private readonly sessionRef: string,
    ) {}

    /** Wire the deliver callback (the kernel routes inbound messages to agents). */
    onMessage(deliver: DeliverInbound): void {
        this.deliver = deliver;
    }

    async start(): Promise<void> {
        this.running = true;
    }

    async stop(): Promise<void> {
        this.running = false;
    }

    async send(_target: string, text: string): Promise<void> {
        // CLI bridge: replies go to stdout (the "channel").
        process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    }

    /** Receive an inbound line (from stdin or a test). Returns the brain reply. */
    async receive(line: string, sender = "cli-user"): Promise<string> {
        if (!this.running) throw new Error("cli bridge is not started");
        if (!this.deliver) throw new Error("cli bridge has no deliver callback");
        const { reply } = await this.deliver({
            listenerRef: this.listenerRef,
            agentRef: this.agentRef,
            sessionRef: this.sessionRef,
            origin: { platform: "cli", channel: "stdout", sender },
            content: line,
        });
        return reply;
    }
}

/** Resolve a listener's bridge from its resource spec. Returns a CliBridge for `cli`. */
export function bridgeForListener(listener: HadesResource, sessionRef: string): ListenerBridge {
    const platform = listener.spec?.platform ?? "cli";
    if (platform === "cli") {
        return new CliBridge(
            listener.metadata?.name ?? "cli",
            listener.spec?.agentRef ?? "",
            sessionRef,
        );
    }
    // Platform bridges (discord/matrix/email/web) are adapters behind this
    // same port; their SDKs are not wired yet. The resource model and routing
    // exist; the bridge SDK is the only missing piece.
    return new UnconfiguredBridge(platform);
}

/** A bridge for platforms whose SDK isn't wired yet — fails loudly on start. */
class UnconfiguredBridge implements ListenerBridge {
    constructor(readonly platform: string) {}
    async start(): Promise<void> {
        throw new Error(`listener bridge for platform '${this.platform}' is not configured (SDK not wired)`);
    }
    async stop(): Promise<void> {}
    async send(): Promise<void> {
        throw new Error(`listener bridge for platform '${this.platform}' is not configured`);
    }
}

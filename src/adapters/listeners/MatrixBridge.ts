import { createClient, type MatrixClient, type MatrixEvent, type Room } from "matrix-js-sdk";
import type { ListenerBridge, DeliverInbound, InboundMessage } from "../../ports/ListenerBridge.js";

/**
 * A {@link ListenerBridge} backed by `matrix-js-sdk`. Connects to a Matrix
 * homeserver with a bot token, receives inbound messages, and routes them to
 * the agent. Brain replies are sent back to the originating room.
 *
 * The bridge is a thin adapter: it turns Matrix events into Hades
 * `listener.message.received` events and routes replies back.
 */
export class MatrixBridge implements ListenerBridge {
    readonly platform = "matrix";
    private client?: MatrixClient;
    private deliver?: DeliverInbound;
    private readonly homeserverUrl: string;
    private readonly accessToken: string;
    private readonly userId: string;
    private readonly listenerRef: string;
    private readonly agentRef: string;
    private readonly sessionRef: string;

    constructor(options: MatrixBridgeOptions) {
        if (!options.accessToken) throw new Error("MatrixBridge requires an access token");
        if (!options.userId) throw new Error("MatrixBridge requires a userId");
        this.homeserverUrl = options.homeserverUrl;
        this.accessToken = options.accessToken;
        this.userId = options.userId;
        this.listenerRef = options.listenerRef;
        this.agentRef = options.agentRef;
        this.sessionRef = options.sessionRef;
    }

    onMessage(deliver: DeliverInbound): void {
        this.deliver = deliver;
    }

    async start(): Promise<void> {
        this.client = createClient({
            baseUrl: this.homeserverUrl,
            accessToken: this.accessToken,
            userId: this.userId,
        });
        // matrix-js-sdk's EventEmitter overloads confuse TS; register dynamically.
        (this.client as unknown as { on: (event: string, handler: (...args: any[]) => void) => void }).on("Room.timeline", (event: MatrixEvent, room: Room) => {
            void this.handleInbound(event, room);
        });
        await this.client.startClient();
    }

    async stop(): Promise<void> {
        this.client?.stopClient();
        this.client = undefined;
    }

    async send(target: string, text: string): Promise<void> {
        if (!this.client) throw new Error("matrix bridge is not started");
        await this.client.sendTextMessage(target, text);
    }

    private async handleInbound(event: MatrixEvent, room: Room): Promise<void> {
        if (!this.deliver) return;
        if (event.getSender() === this.userId) return; // ignore own messages
        const content = event.getContent();
        if (content.msgtype !== "m.text") return;
        const inbound: InboundMessage = {
            listenerRef: this.listenerRef,
            agentRef: this.agentRef,
            sessionRef: this.sessionRef,
            origin: {
                platform: "matrix",
                channel: room.roomId,
                sender: event.getSender() ?? "unknown",
                thread: null,
            },
            content: String(content.body ?? ""),
        };
        const { reply } = await this.deliver(inbound);
        await this.client!.sendTextMessage(room.roomId, reply);
    }
}

export type MatrixBridgeOptions = {
    homeserverUrl: string;
    accessToken: string;
    userId: string;
    listenerRef: string;
    agentRef: string;
    sessionRef: string;
};

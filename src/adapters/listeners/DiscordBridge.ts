import { Client, GatewayIntentBits, type Message } from "discord.js";
import type { ListenerBridge, DeliverInbound, InboundMessage } from "../../ports/ListenerBridge.js";

/**
 * A {@link ListenerBridge} backed by `discord.js`. Connects to Discord with a
 * bot token (from the `Listener`'s `secretRef`), receives inbound messages, and
 * routes them to the agent via the {@link DeliverInbound} callback. Brain
 * replies are sent back to the originating channel/thread.
 *
 * The bridge is a thin adapter: it turns Discord events into Hades
 * `listener.message.received` events and routes replies back. Listener pods
 * are cattle — if the bridge crashes, the agent and session persist.
 *
 * Construct with a token (the controller resolves it from the `Listener`
 * `secretRef`); the deliver callback is wired by the kernel.
 */
export class DiscordBridge implements ListenerBridge {
    readonly platform = "discord";
    private client?: Client;
    private deliver?: DeliverInbound;
    private readonly token: string;
    private readonly listenerRef: string;
    private readonly agentRef: string;
    private readonly sessionRef: string;

    constructor(options: DiscordBridgeOptions) {
        if (!options.token) throw new Error("DiscordBridge requires a token");
        this.token = options.token;
        this.listenerRef = options.listenerRef;
        this.agentRef = options.agentRef;
        this.sessionRef = options.sessionRef;
    }

    /** Wire the deliver callback (the kernel routes inbound messages to agents). */
    onMessage(deliver: DeliverInbound): void {
        this.deliver = deliver;
    }

    async start(): Promise<void> {
        this.client = new Client({ intents: [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.Guilds] });
        this.client.on("messageCreate", (message: Message) => {
            if (message.author.bot) return;
            void this.handleInbound(message);
        });
        await this.client.login(this.token);
    }

    async stop(): Promise<void> {
        await this.client?.destroy();
        this.client = undefined;
    }

    async send(target: string, text: string): Promise<void> {
        if (!this.client) throw new Error("discord bridge is not started");
        const channel = await this.client.channels.fetch(target);
        if (!channel || !("send" in channel)) throw new Error(`discord channel ${target} is not a text channel`);
        await (channel as { send: (t: string) => Promise<unknown> }).send(text);
    }

    private async handleInbound(message: Message): Promise<void> {
        if (!this.deliver) return;
        const inbound: InboundMessage = {
            listenerRef: this.listenerRef,
            agentRef: this.agentRef,
            sessionRef: this.sessionRef,
            origin: {
                platform: "discord",
                channel: message.channelId,
                sender: message.author.tag,
                thread: message.thread?.id ?? null,
            },
            content: message.content,
        };
        const { reply } = await this.deliver(inbound);
        await message.reply(reply);
    }
}

export type DiscordBridgeOptions = {
    token: string;
    listenerRef: string;
    agentRef: string;
    sessionRef: string;
};

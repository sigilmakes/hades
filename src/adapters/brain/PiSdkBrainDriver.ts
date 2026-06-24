import { nameOf, type HadesResource } from "../../domain/resources.js";
import type { BrainDriver, BrainRunInput } from "../../ports/BrainDriver.js";
import type { EventStorePort } from "../../ports/EventStore.js";
import type { HandsBackend } from "../../ports/HandsBackend.js";
import { HadesToolRegistrar } from "./HadesToolRegistrar.js";

export class PiSdkBrainDriver implements BrainDriver {
    readonly mode = "pi-sdk";

    constructor(
        private readonly events: EventStorePort,
        private readonly homeRootFor: (agent: HadesResource) => string,
        private readonly handsFor: (agent: HadesResource, session: HadesResource) => HandsBackend,
    ) {}

    async run({ agent, session, prompt }: BrainRunInput): Promise<string> {
        const [{ Type }, pi] = await Promise.all([
            import("@earendil-works/pi-ai"),
            import("@earendil-works/pi-coding-agent"),
        ]);
        const { createAgentSession, DefaultResourceLoader, defineTool, getAgentDir, SessionManager } = pi;
        const homeRoot = this.homeRootFor(agent);
        const hands = this.handsFor(agent, session);
        const resourceLoader = new DefaultResourceLoader({
            cwd: homeRoot,
            agentDir: getAgentDir(),
            extensionFactories: [
                (api: unknown) => new HadesToolRegistrar(hands, defineTool, Type).register(api as any),
            ],
        });
        await resourceLoader.reload();
        const { session: piSession } = await createAgentSession({
            cwd: homeRoot,
            resourceLoader,
            tools: ["hades_read", "hades_write", "hades_exec"],
            sessionManager: SessionManager.inMemory(homeRoot),
        });
        let text = "";
        const unsubscribe = piSession.subscribe((event: any) => {
            if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
                text += event.assistantMessageEvent.delta;
            }
        });
        try {
            await piSession.prompt(prompt);
        } finally {
            unsubscribe?.();
            piSession.dispose();
        }
        await this.events.append(nameOf(session), "brain.model.completed", { provider: "pi-sdk", bytes: text.length });
        await this.events.append(nameOf(session), "agent.message", { agent: nameOf(agent), text });
        return text;
    }
}

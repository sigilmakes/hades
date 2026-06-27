import { nameOf, type AgentSubject, type HadesResource } from "../../domain/resources.js";
import type { BrainDriver, BrainRunInput } from "../../ports/BrainDriver.js";
import type { EventStorePort } from "../../ports/EventStore.js";
import type { HandsBackend } from "../../ports/HandsBackend.js";
import type { PolicyPort } from "../../ports/Policy.js";
import { HadesToolRegistrar, type SyscallEndpoint } from "./HadesToolRegistrar.js";
import { ConnectorToolRegistrar, connectorsFromEnv, type SecretResolver } from "./ConnectorToolRegistrar.js";
import path from "node:path";
import { mkdir } from "node:fs/promises";

export class PiSdkBrainDriver implements BrainDriver {
    readonly mode = "pi-sdk";

    constructor(
        private readonly events: EventStorePort,
        private readonly homeRootFor: (agent: HadesResource) => string,
        private readonly handsFor: (agent: HadesResource, session: HadesResource) => HandsBackend,
        /** Policy + secret resolver for outbound connector tools. Optional: when
         * absent (e.g. offline tests), only the home tools are registered. */
        private readonly connectors?: { policy: PolicyPort; secrets: SecretResolver },
        /** The agent's identity + the kernel API URL, for hades_install. */
        private readonly self?: { subject: { kind: string; name: string; namespace: string }; apiUrl: string },
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
                (api: unknown) => new HadesToolRegistrar(hands, defineTool, Type, this.self ? { subject: this.self.subject, syscalls: kernelSyscalls(this.self.apiUrl) } : undefined).register(api as { registerTool(tool: unknown): void }),
                ...(this.connectors ? [
                    (api: unknown) => new ConnectorToolRegistrar(
                        { kind: "Agent", name: nameOf(agent), namespace: agent.metadata?.namespace ?? "default" } satisfies AgentSubject,
                        this.connectors.policy, this.connectors.secrets, defineTool, Type,
                        connectorsFromEnv(),
                    ).register(api as { registerTool(tool: unknown): void }),
                ] : []),
            ],
        });
        await resourceLoader.reload();
        // Persist the pi-SDK session to the home PVC so context survives across
        // prompts and brain pod restarts. continueRecent reopens the most recent
        // session file (or creates one on first wake); the SDK's own compaction
        // handles context-window overflow. This is the "replay context from the
        // event log" step described in docs/brain-and-session.md.
        const sessionDir = path.join(homeRoot, ".hades", "sessions", nameOf(session));
        await mkdir(sessionDir, { recursive: true });
        const sessionManager = SessionManager.continueRecent(homeRoot, sessionDir);
        const { session: piSession } = await createAgentSession({
            cwd: homeRoot,
            resourceLoader,
            tools: ["hades_read", "hades_write", "hades_exec", ...(this.connectors ? connectorsFromEnv().map((c) => `hades_call_${c.name}`) : []), ...(this.self ? ["hades_install"] : [])],
            sessionManager,
        });
        let text = "";
        type SessionEvent = { type: string; assistantMessageEvent?: { type: string; delta?: string } };
        const unsubscribe = piSession.subscribe((event: SessionEvent) => {
            if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
                text += event.assistantMessageEvent.delta ?? "";
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

/** A {@link SyscallEndpoint} that POSTs to the Hades kernel API. Userland
 * plumbing: the brain calls the kernel over HTTP, exactly as any client does. */
function kernelSyscalls(apiUrl: string): SyscallEndpoint {
    return {
        installPackages: async (subject, spec) => {
            const res = await fetch(`${apiUrl}/hades/v1/syscalls/install-packages`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ subject, spec }),
            });
            if (!res.ok) throw new Error(`installPackages failed: ${res.status} ${await res.text()}`);
            return res.json();
        },
    };
}

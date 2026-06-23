import path from "node:path";
import { HandsExecutor } from "./hands.js";
import { PolicyEngine } from "./policy.js";
import type { EventStore } from "./events.js";
import type { StateStore } from "./state.js";
import type { HadesResource } from "./types.js";

type BrainOptions = {
    state: StateStore;
    events: EventStore;
    dataDir: string;
};

export class BrainRuntime {
    state: StateStore;
    events: EventStore;
    dataDir: string;

    constructor({ state, events, dataDir }: BrainOptions) {
        this.state = state;
        this.events = events;
        this.dataDir = dataDir;
    }

    async run(agent: HadesResource, session: HadesResource, prompt: string): Promise<string> {
        const agentName = requiredName(agent);
        const mode = this.brainMode(agent);
        await this.events.append(requiredName(session), "brain.woke", { agent: agentName, mode });

        if (mode === "deterministic") return this.runDeterministic(agent, session, prompt);
        return this.runPiSdk(agent, session, prompt);
    }

    brainMode(agent: HadesResource): "pi-sdk" | "deterministic" {
        const configured = process.env.HADES_BRAIN_MODE ?? agent.spec?.brain?.mode;
        if (!configured) return "pi-sdk";
        if (configured === "pi-sdk" || configured === "deterministic") return configured;
        throw new Error(`Unsupported brain mode ${configured}`);
    }

    async runPiSdk(agent: HadesResource, session: HadesResource, prompt: string): Promise<string> {
        const [{ Type }, pi] = await Promise.all([
            import("@earendil-works/pi-ai"),
            import("@earendil-works/pi-coding-agent"),
        ]);
        const { createAgentSession, DefaultResourceLoader, defineTool, getAgentDir, SessionManager } = pi;
        const homeRoot = this.homeRoot(agent);
        const hands = new HandsExecutor({ homeRoot, events: this.events, sessionId: requiredName(session) });
        const resourceLoader = new DefaultResourceLoader({
            cwd: homeRoot,
            agentDir: getAgentDir(),
            extensionFactories: [
                (api: any) => {
                    api.registerTool(defineTool({
                        name: "hades_read",
                        label: "Hades Read",
                        description: "Read a file from the agent Home through Hades Hands.",
                        parameters: Type.Object({ path: Type.String() }),
                        execute: async (_id: string, params: { path: string }) => ({
                            content: [{ type: "text", text: await hands.read(params.path) }],
                            details: { path: params.path },
                        }),
                    }));
                    api.registerTool(defineTool({
                        name: "hades_write",
                        label: "Hades Write",
                        description: "Write a file in the agent Home through Hades Hands.",
                        parameters: Type.Object({ path: Type.String(), content: Type.String() }),
                        execute: async (_id: string, params: { path: string; content: string }) => {
                            const result = await hands.write(params.path, params.content);
                            return { content: [{ type: "text", text: `wrote ${result.path} (${result.bytes} bytes)` }], details: result };
                        },
                    }));
                    api.registerTool(defineTool({
                        name: "hades_bash",
                        label: "Hades Bash",
                        description: "Run a confined Home-relative executable through Hades Hands.",
                        parameters: Type.Object({ command: Type.String(), cwd: Type.Optional(Type.String()) }),
                        execute: async (_id: string, params: { command: string; cwd?: string }) => {
                            const result = await hands.bash(params.command, params.cwd ?? ".");
                            return { content: [{ type: "text", text: result.stdout || result.stderr || `exit ${result.code}` }], details: result };
                        },
                    }));
                },
            ],
        });
        await resourceLoader.reload();
        const { session: piSession } = await createAgentSession({
            cwd: homeRoot,
            resourceLoader,
            tools: ["hades_read", "hades_write", "hades_bash"],
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
        await this.events.append(requiredName(session), "brain.model.completed", { provider: "pi-sdk", bytes: text.length });
        await this.events.append(requiredName(session), "agent.message", { agent: requiredName(agent), text });
        return text;
    }

    async runDeterministic(agent: HadesResource, session: HadesResource, prompt: string): Promise<string> {
        const sessionName = requiredName(session);
        const hands = new HandsExecutor({ homeRoot: this.homeRoot(agent), events: this.events, sessionId: sessionName });
        const trimmed = prompt.trim();
        let reply: string;
        try {
            if (trimmed.startsWith("!write ")) {
                const match = trimmed.match(/^!write\s+([\s\S]+)$/);
                if (!match) throw new Error("write directive format: !write <path> <<< <content>");
                const [file, content = ""] = match[1].split("<<<");
                const result = await hands.write(file.trim(), content.trimStart());
                reply = `wrote ${result.path} (${result.bytes} bytes)`;
            } else if (trimmed.startsWith("!read ")) {
                const file = trimmed.replace(/^!read\s+/, "").trim();
                reply = await hands.read(file);
            } else if (trimmed.startsWith("!bash ")) {
                const result = await hands.bash(trimmed.replace(/^!bash\s+/, ""));
                reply = result.stdout || result.stderr || `exit ${result.code}`;
            } else if (trimmed.startsWith("!schedule ")) {
                reply = await this.createScheduleFromDirective(agent, session, trimmed);
            } else {
                reply = `${agent.spec?.displayName ?? requiredName(agent)} received: ${prompt}`;
            }
            await this.events.append(sessionName, "brain.model.completed", { provider: "deterministic", bytes: reply.length });
            await this.events.append(sessionName, "agent.message", { agent: requiredName(agent), text: reply });
            await this.events.append(sessionName, "brain.sleeping", { checkpoint: "latest" });
            return reply;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.events.append(sessionName, "brain.failed", { message });
            throw error;
        }
    }

    async createScheduleFromDirective(agent: HadesResource, session: HadesResource, directive: string): Promise<string> {
        const match = directive.match(/^!schedule\s+(\S+)\s+(once|interval)\s+([\s\S]+?)\s+::\s*([\s\S]+)$/);
        if (!match) throw new Error("schedule directive format: !schedule <name> once|interval <when> :: <prompt>");
        const [, name, type, schedule, prompt] = match;
        const subject = { kind: "Agent", name: requiredName(agent), namespace: requiredNamespace(agent) };
        const policy = new PolicyEngine(this.state);
        policy.assert(subject, "createOwnSchedule", { namespace: subject.namespace });
        const resource: HadesResource = {
            apiVersion: "hades.dev/v1alpha1",
            kind: "Schedule",
            metadata: { namespace: subject.namespace, name },
            spec: {
                agentRef: subject.name,
                type,
                schedule: schedule.trim(),
                session: requiredName(session),
                prompt,
            },
            status: { phase: "pending" },
        };
        await this.state.apply(resource);
        await this.events.append(requiredName(session), "schedule.created", { schedule: name, by: requiredName(agent) });
        return `created schedule ${name}`;
    }

    homeRoot(agent: HadesResource): string {
        const homeName = agent.spec?.homeRef ?? `${requiredName(agent)}-home`;
        const home = this.state.findByName("Home", homeName, requiredNamespace(agent));
        if (typeof home?.status?.path === "string") return home.status.path;
        return path.join(this.dataDir, "homes", requiredNamespace(agent), homeName);
    }
}

function requiredName(resource: HadesResource): string {
    const name = resource.metadata?.name;
    if (!name) throw new Error(`${resource.kind} is missing metadata.name`);
    return name;
}

function requiredNamespace(resource: HadesResource): string {
    return resource.metadata?.namespace ?? "default";
}

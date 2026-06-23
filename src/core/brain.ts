import path from "node:path";
import { HandsExecutor } from "./hands.js";
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
        await this.events.append(requiredName(session), "brain.woke", {
            agent: agentName,
            mode: process.env.HADES_USE_PI_SDK === "1" ? "pi-sdk" : "deterministic",
        });

        if (process.env.HADES_USE_PI_SDK === "1") {
            return this.runPiSdk(agent, session, prompt);
        }
        return this.runDeterministic(agent, session, prompt);
    }

    async runPiSdk(agent: HadesResource, session: HadesResource, prompt: string): Promise<string> {
        const { createAgentSession, SessionManager } = await import("@earendil-works/pi-coding-agent");
        const homeRoot = this.homeRoot(agent);
        const { session: piSession } = await createAgentSession({
            cwd: homeRoot,
            tools: ["read", "bash"],
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
        const resource: HadesResource = {
            apiVersion: "hades.dev/v1alpha1",
            kind: "Schedule",
            metadata: { namespace: requiredNamespace(agent), name },
            spec: {
                agentRef: requiredName(agent),
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

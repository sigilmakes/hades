import path from "node:path";
import { HandsExecutor } from "./hands.js";

export class BrainRuntime {
    constructor({ state, events, dataDir }) {
        this.state = state;
        this.events = events;
        this.dataDir = dataDir;
    }

    async run(agent, session, prompt, origin = {}) {
        const namespace = agent.metadata.namespace;
        const agentName = agent.metadata.name;
        await this.events.append(session.metadata.name, "brain.woke", { agent: agentName, mode: process.env.HADES_USE_PI_SDK === "1" ? "pi-sdk" : "deterministic" });

        if (process.env.HADES_USE_PI_SDK === "1") {
            return this.runPiSdk(agent, session, prompt);
        }
        return this.runDeterministic(agent, session, prompt, origin);
    }

    async runPiSdk(agent, session, prompt) {
        const { createAgentSession, SessionManager } = await import("@earendil-works/pi-coding-agent");
        const homeRoot = this.homeRoot(agent);
        const { session: piSession } = await createAgentSession({
            cwd: homeRoot,
            tools: ["read", "bash"],
            sessionManager: SessionManager.inMemory(homeRoot),
        });
        let text = "";
        const unsubscribe = piSession.subscribe((event) => {
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
        await this.events.append(session.metadata.name, "brain.model.completed", { provider: "pi-sdk", bytes: text.length });
        await this.events.append(session.metadata.name, "agent.message", { agent: agent.metadata.name, text });
        return text;
    }

    async runDeterministic(agent, session, prompt) {
        const hands = new HandsExecutor({ homeRoot: this.homeRoot(agent), events: this.events, sessionId: session.metadata.name });
        const trimmed = prompt.trim();
        let reply;
        try {
            if (trimmed.startsWith("!write ")) {
                const [, rest] = trimmed.match(/^!write\s+([\s\S]+)$/);
                const [file, content = ""] = rest.split("<<<");
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
                reply = `${agent.spec?.displayName ?? agent.metadata.name} received: ${prompt}`;
            }
            await this.events.append(session.metadata.name, "brain.model.completed", { provider: "deterministic", bytes: reply.length });
            await this.events.append(session.metadata.name, "agent.message", { agent: agent.metadata.name, text: reply });
            await this.events.append(session.metadata.name, "brain.sleeping", { checkpoint: "latest" });
            return reply;
        } catch (error) {
            await this.events.append(session.metadata.name, "brain.failed", { message: error.message });
            throw error;
        }
    }

    async createScheduleFromDirective(agent, session, directive) {
        const match = directive.match(/^!schedule\s+(\S+)\s+(once|interval)\s+([\s\S]+?)\s+::\s*([\s\S]+)$/);
        if (!match) throw new Error("schedule directive format: !schedule <name> once|interval <when> :: <prompt>");
        const [, name, type, schedule, prompt] = match;
        const resource = {
            apiVersion: "hades.dev/v1alpha1",
            kind: "Schedule",
            metadata: { namespace: agent.metadata.namespace, name },
            spec: {
                agentRef: agent.metadata.name,
                type,
                schedule: schedule.trim(),
                session: session.metadata.name,
                prompt,
            },
            status: { phase: "pending" },
        };
        await this.state.apply(resource);
        await this.events.append(session.metadata.name, "schedule.created", { schedule: name, by: agent.metadata.name });
        return `created schedule ${name}`;
    }

    homeRoot(agent) {
        const homeName = agent.spec?.homeRef ?? `${agent.metadata.name}-home`;
        const home = this.state.findByName("Home", homeName, agent.metadata.namespace);
        if (home?.status?.path) return home.status.path;
        return path.join(this.dataDir, "homes", agent.metadata.namespace, homeName);
    }
}

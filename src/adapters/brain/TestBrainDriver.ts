import { nameOf, namespaceOf, type HadesResource } from "../../domain/resources.js";
import type { BrainDriver, BrainRunInput } from "../../ports/BrainDriver.js";
import type { EventStorePort } from "../../ports/EventStore.js";
import type { HandsBackend } from "../../ports/HandsBackend.js";
import type { ScheduleService } from "../../services/ScheduleService.js";

export type SpawnCallback = (subject: { kind: "Agent"; name: string; namespace: string }, spec: Record<string, any>) => Promise<{ agent: HadesResource; reply: string }>;
export type MessageCallback = (agentName: string, text: string, options: { namespace?: string }) => Promise<{ reply: string }>;

export class TestBrainDriver implements BrainDriver {
    readonly mode = "test";

    constructor(
        private readonly events: EventStorePort,
        private readonly handsFor: (agent: HadesResource, session: HadesResource) => HandsBackend,
        private readonly schedules: ScheduleService,
        private readonly spawn?: SpawnCallback,
        private readonly message?: MessageCallback,
    ) {}

    async run({ agent, session, prompt, onToken }: BrainRunInput): Promise<string> {
        const sessionName = nameOf(session);
        const hands = this.handsFor(agent, session);
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
            } else if (trimmed.startsWith("!exec ")) {
                const result = await hands.exec({ command: trimmed.replace(/^!exec\s+/, "") });
                reply = result.stdout || result.stderr || `exit ${result.code}`;
            } else if (trimmed.startsWith("!schedule ")) {
                reply = await this.createScheduleFromDirective(agent, session, trimmed);
            } else if (trimmed.startsWith("!spawn ")) {
                reply = await this.spawnFromDirective(agent, trimmed);
            } else if (trimmed.startsWith("!message ")) {
                reply = await this.messageFromDirective(agent, trimmed);
            } else if (trimmed.startsWith("!")) {
                throw new Error(`Unsupported test brain directive: ${trimmed.split(/\s+/, 1)[0]}`);
            } else {
                reply = `${agent.spec?.displayName ?? nameOf(agent)} received: ${prompt}`;
            }
            await this.events.append(sessionName, "brain.model.completed", { provider: "test", bytes: reply.length });
            await this.events.append(sessionName, "agent.message", { agent: nameOf(agent), text: reply });
            await this.events.append(sessionName, "brain.sleeping", { checkpoint: "latest" });
            onToken?.(reply);
            return reply;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.events.append(sessionName, "brain.failed", { message });
            throw error;
        }
    }

    private async createScheduleFromDirective(agent: HadesResource, session: HadesResource, directive: string): Promise<string> {
        const match = directive.match(/^!schedule\s+(\S+)\s+(once|interval)\s+([\s\S]+?)\s+::\s*([\s\S]+)$/);
        if (!match) throw new Error("schedule directive format: !schedule <name> once|interval <when> :: <prompt>");
        const [, name, type, schedule, prompt] = match;
        await this.schedules.createOwnSchedule(
            { kind: "Agent", name: nameOf(agent), namespace: namespaceOf(agent) },
            { name, agentRef: nameOf(agent), type, schedule: schedule.trim(), session: nameOf(session), prompt },
        );
        return `created schedule ${name}`;
    }

    private async spawnFromDirective(agent: HadesResource, directive: string): Promise<string> {
        if (!this.spawn) throw new Error("spawn is not configured for this brain");
        // !spawn <name> [resident] <prompt>
        const match = directive.match(/^!spawn\s+(\S+)(?:\s+(resident))?\s+([\s\S]+)$/);
        if (!match) throw new Error("spawn directive format: !spawn <name> [resident] <prompt>");
        const [, name, resident, prompt] = match;
        const lifecycle = resident === "resident" ? "resident" : "ephemeral";
        const result = await this.spawn(
            { kind: "Agent", name: nameOf(agent), namespace: namespaceOf(agent) },
            { name, prompt, lifecycle },
        );
        return `spawned ${name} (${lifecycle}): ${result.reply}`;
    }

    private async messageFromDirective(agent: HadesResource, directive: string): Promise<string> {
        if (!this.message) throw new Error("message is not configured for this brain");
        // !message <agent-name> <text>
        const match = directive.match(/^!message\s+(\S+)\s+([\s\S]+)$/);
        if (!match) throw new Error("message directive format: !message <agent-name> <text>");
        const [, targetName, text] = match;
        const result = await this.message(targetName, text, { namespace: namespaceOf(agent) });
        return `messaged ${targetName}: ${result.reply}`;
    }
}

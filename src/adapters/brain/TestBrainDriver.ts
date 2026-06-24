import { nameOf, namespaceOf, type HadesResource } from "../../domain/resources.js";
import type { BrainDriver, BrainRunInput } from "../../ports/BrainDriver.js";
import type { EventStorePort } from "../../ports/EventStore.js";
import type { HandsBackend } from "../../ports/HandsBackend.js";
import type { ScheduleService } from "../../services/ScheduleService.js";

export class TestBrainDriver implements BrainDriver {
    readonly mode = "test";

    constructor(
        private readonly events: EventStorePort,
        private readonly handsFor: (agent: HadesResource, session: HadesResource) => HandsBackend,
        private readonly schedules: ScheduleService,
    ) {}

    async run({ agent, session, prompt }: BrainRunInput): Promise<string> {
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
            } else {
                reply = `${agent.spec?.displayName ?? nameOf(agent)} received: ${prompt}`;
            }
            await this.events.append(sessionName, "brain.model.completed", { provider: "test", bytes: reply.length });
            await this.events.append(sessionName, "agent.message", { agent: nameOf(agent), text: reply });
            await this.events.append(sessionName, "brain.sleeping", { checkpoint: "latest" });
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
}

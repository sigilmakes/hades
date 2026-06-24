import { nameOf, namespaceOf, type HadesResource } from "../domain/resources.js";
import type { EventStorePort } from "../ports/EventStore.js";
import type { StateStorePort } from "../ports/StateStore.js";
import { AgentService } from "./AgentService.js";
import { BrainService } from "./BrainService.js";

type MessageOptions = {
    namespace?: string;
    origin?: Record<string, any>;
};

export class MessageService {
    constructor(
        private readonly state: StateStorePort,
        private readonly events: EventStorePort,
        private readonly agents: AgentService,
        private readonly brain: BrainService,
    ) {}

    async messageAgent(agentName: string, text: string, options: MessageOptions = {}): Promise<{ run: HadesResource; reply: string }> {
        const agent = this.agents.resolveAgent(agentName, options.namespace);
        const namespace = namespaceOf(agent);
        if (agent.spec?.lifecycle === "ephemeral" && agent.status?.phase === "completed") {
            throw new Error(`Agent ${namespace}/${nameOf(agent)} is a reaped ephemeral worker and cannot be re-activated`);
        }
        const sessionName = agent.status?.session ?? agent.spec?.defaultSession ?? `${nameOf(agent)}-default`;
        let session = this.state.findByName("Session", sessionName, namespace);
        if (!session) {
            await this.agents.reconcileAgents();
            session = this.state.findByName("Session", sessionName, namespace);
        }
        if (!session) throw new Error(`Session ${namespace}/${sessionName} not found`);
        await this.events.append(nameOf(session), options.origin?.kind === "Schedule" ? "schedule.message" : "listener.message.received", {
            text,
            origin: options.origin ?? { kind: "cli" },
        });
        const run: HadesResource = {
            apiVersion: "hades.dev/v1alpha1",
            kind: "Run",
            metadata: { namespace, name: `run-${Date.now()}` },
            spec: { agentRef: agentName, sessionRef: nameOf(session), input: text },
            status: { phase: "running", startedAt: new Date().toISOString() },
        };
        await this.state.apply(run);
        const reply = await this.brain.run(agent, session, text);
        run.status ??= {};
        run.status.phase = "completed";
        run.status.completedAt = new Date().toISOString();
        await this.state.save();
        return { run, reply };
    }
}

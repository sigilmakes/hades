import { nameOf, namespaceOf, type AgentSubject, type HadesResource } from "../domain/resources.js";
import type { EventStorePort } from "../ports/EventStore.js";
import type { StateStorePort } from "../ports/StateStore.js";
import { PolicyService } from "./PolicyService.js";

type DeliverScheduledMessage = (agentName: string, text: string, options: { namespace: string; origin: Record<string, any> }) => Promise<unknown>;

export class ScheduleService {
    constructor(
        private readonly state: StateStorePort,
        private readonly events: EventStorePort,
        private readonly policy: PolicyService,
    ) {}

    async reconcileSchedules(deliver: DeliverScheduledMessage): Promise<void> {
        for (const schedule of this.state.list("Schedule")) {
            schedule.status ??= {};
            schedule.status.phase ??= "pending";
            if (schedule.spec?.type === "once" && !schedule.status.firedAt && isDue(schedule.spec.schedule)) {
                await this.fireSchedule(schedule, deliver);
            }
        }
    }

    async fireSchedule(schedule: HadesResource, deliver: DeliverScheduledMessage): Promise<void> {
        const namespace = namespaceOf(schedule);
        const agent = this.state.findByName("Agent", schedule.spec?.agentRef, namespace);
        if (!agent) throw new Error(`Schedule ${nameOf(schedule)} references missing agent ${schedule.spec?.agentRef}`);
        const session = this.state.findByName("Session", schedule.spec?.session ?? agent.spec?.defaultSession ?? `${nameOf(agent)}-default`, namespace);
        if (!session) throw new Error(`Schedule ${nameOf(schedule)} references missing session`);
        await this.events.append(nameOf(session), "schedule.fired", { schedule: nameOf(schedule) });
        schedule.status ??= {};
        schedule.status.firedAt = new Date().toISOString();
        schedule.status.phase = "completed";
        await deliver(nameOf(agent), schedule.spec?.prompt ?? `Schedule ${nameOf(schedule)} fired`, {
            namespace,
            origin: { kind: "Schedule", name: nameOf(schedule) },
        });
    }

    async createOwnSchedule(subject: Partial<AgentSubject>, spec: Record<string, any>): Promise<HadesResource> {
        const resolvedSubject = this.policy.resolveAgentSubject(subject);
        this.policy.assert(resolvedSubject, "createOwnSchedule", { namespace: resolvedSubject.namespace });
        const agentRef = spec.agentRef ?? resolvedSubject.name;
        if (agentRef !== resolvedSubject.name) throw new Error(`createOwnSchedule cannot target another agent: ${agentRef}`);
        const sessionName = spec.session ?? `${resolvedSubject.name}-default`;
        const session = this.state.findByName("Session", sessionName, resolvedSubject.namespace);
        if (!session) throw new Error(`createOwnSchedule requires an existing session: ${sessionName}`);
        if (session.spec?.agentRef !== resolvedSubject.name) {
            throw new Error(`createOwnSchedule cannot target another agent's session: ${sessionName}`);
        }
        const normalizedSpec = { ...spec, agentRef, session: sessionName };
        const resource: HadesResource = {
            apiVersion: "hades.dev/v1alpha1",
            kind: "Schedule",
            metadata: { namespace: resolvedSubject.namespace, name: spec.name },
            spec: normalizedSpec,
            status: { phase: "pending" },
        };
        await this.state.apply(resource);
        await this.events.append(sessionName, "schedule.created", { schedule: spec.name, by: resolvedSubject.name });
        return resource;
    }
}

function isDue(value: string | undefined): boolean {
    if (!value) return false;
    if (value.startsWith("+")) {
        const amount = Number(value.slice(1, -1));
        const unit = value.at(-1);
        const ms = unit === "s" ? amount * 1000 : unit === "m" ? amount * 60_000 : amount * 3600_000;
        return ms <= 0;
    }
    const time = Date.parse(value);
    return Number.isFinite(time) && time <= Date.now();
}

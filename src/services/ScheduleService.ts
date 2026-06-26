import { nameOf, namespaceOf, type AgentSubject, type HadesResource } from "../domain/resources.js";
import { isScheduleDue } from "../domain/schedule-due.js";
import type { EventStorePort } from "../ports/EventStore.js";
import type { StateStorePort } from "../ports/StateStore.js";
import { type PolicyService } from "./PolicyService.js";

type DeliverScheduledMessage = (agentName: string, text: string, options: { namespace: string; origin: Record<string, any> }) => Promise<unknown>;

export class ScheduleService {
    constructor(
        private readonly state: StateStorePort,
        private readonly events: EventStorePort,
        private readonly policy: PolicyService,
    ) {}

    async reconcileSchedules(deliver: DeliverScheduledMessage): Promise<void> {
        const now = Date.now();
        for (const schedule of this.state.list("Schedule")) {
            schedule.status ??= {};
            schedule.status.phase ??= "pending";
            schedule.status.createdAt ??= new Date(now).toISOString();
            if (schedule.status.phase === "invalid") continue;
            const recurring = schedule.spec?.type === "interval" || schedule.spec?.type === "cron";
            let due: boolean;
            try {
                due = isScheduleDue(schedule.spec ?? {}, schedule.status.lastFiredAt, schedule.status.createdAt, now);
            } catch (error) {
                // Parse/config error: this schedule is structurally invalid. Mark it and move on;
                // it is skipped on future passes until the operator fixes and re-applies it.
                const message = error instanceof Error ? error.message : String(error);
                schedule.status.phase = "invalid";
                schedule.status.error = message;
                await this.events.append("system", "schedule.invalid", { schedule: nameOf(schedule), error: message }).catch(() => {});
                continue;
            }
            try {
                if (recurring) {
                    schedule.status.phase = "active";
                    if (!due) continue;
                    // Claim this occurrence synchronously before any await so a concurrent
                    // reconcile cannot double-fire. A transient delivery failure below does NOT
                    // mark the schedule invalid: lastFiredAt simply means this occurrence is spent.
                    schedule.status.lastFiredAt = new Date().toISOString();
                    await this.fireSchedule(schedule, deliver);
                    continue;
                }
                if (schedule.spec?.type === "once" && !schedule.status.firedAt && due) {
                    schedule.status.firedAt = new Date().toISOString();
                    await this.fireSchedule(schedule, deliver);
                }
            } catch (error) {
                // Transient delivery/event failure: record it, keep the schedule active so it
                // retries on the next due occurrence. Do not invalidate.
                const message = error instanceof Error ? error.message : String(error);
                await this.events.append("system", "schedule.failed", { schedule: nameOf(schedule), error: message }).catch(() => {});
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
        const recurring = schedule.spec?.type === "interval" || schedule.spec?.type === "cron";
        schedule.status.phase = recurring ? "active" : "completed";
        await deliver(nameOf(agent), schedule.spec?.prompt ?? `Schedule ${nameOf(schedule)} fired`, {
            namespace,
            origin: { kind: "Schedule", name: nameOf(schedule) },
        });
    }

    async createOwnSchedule(subject: Partial<AgentSubject>, spec: Record<string, any>): Promise<HadesResource> {
        const resolvedSubject = this.policy.resolveAgentSubject(subject);
        this.policy.assert(resolvedSubject, "createOwnSchedule", { namespace: resolvedSubject.namespace });
        this.policy.assertQuota(resolvedSubject.namespace, "Schedule");
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
            status: { phase: "pending", createdAt: new Date().toISOString() },
        };
        await this.state.apply(resource);
        await this.events.append(sessionName, "schedule.created", { schedule: spec.name, by: resolvedSubject.name });
        return resource;
    }
}
import { nameOf, namespaceOf } from "../domain/resources.js";
import type { EventStorePort } from "../ports/EventStore.js";
import type { StateStorePort } from "../ports/StateStore.js";

/**
 * Projections: derived views over durable state + events (docs/control-plane.md). The UI and
 * `kubectl`-style inspection should not replay every raw event on every frame;
 * projections are pre-computed summaries.
 *
 * Raw events remain authoritative (docs/control-plane.md invariant). Projections are caches.
 *
 * `agentTree`/`runSummaries`/`approvalQueue`/etc. read the in-memory state mirror
 * (always fresh, cheap). `activityTail` is backed by an {@link ActivityProjection}
 * maintained on event subscribe — a bounded ring buffer rebuilt from the durable
 * log on init, then incrementally updated as events arrive. Reads are O(1).
 */
export class ProjectionService {
    private readonly activity: ActivityProjection;

    constructor(
        private readonly state: StateStorePort,
        private readonly events: EventStorePort,
    ) {
        this.activity = new ActivityProjection(200);
    }

    /**
     * Start the projection store: replay the durable event log into the activity
     * buffer, then subscribe to keep it incrementally updated. Idempotent.
     */
    async start(): Promise<void> {
        if (this.started) return;
        const all = await this.events.list();
        this.activity.seed(all);
        this.events.subscribe?.((event) => this.activity.push(event));
        this.started = true;
    }

    private started = false;


    /** Agent tree: every agent with its phase, lifecycle, brain/hands pod names. */
    agentTree(namespace?: string): AgentTreeNode[] {
        return this.state.list("Agent", namespace).map((agent) => ({
            name: nameOf(agent),
            namespace: namespaceOf(agent),
            lifecycle: agent.spec?.lifecycle ?? "resident",
            phase: agent.status?.phase ?? "unknown",
            brainPod: agent.status?.brainPod,
            session: agent.status?.session ?? agent.spec?.defaultSession,
            systemAgent: Boolean(agent.spec?.systemAgent),
        }));
    }

    /** Recent activity: the last N events across all (or one) session. */
    async activityTail(sessionId: string | undefined, limit = 50): Promise<ActivityEntry[]> {
        // Read from the projection store when started (O(1)); fall back to a
        // durable-log replay otherwise (always-fresh, but O(n)).
        const events = this.started
            ? this.activity.tail(sessionId, limit)
            : (await this.events.list(sessionId)).slice(-limit);
        return events.map((e) => ({
            id: e.id,
            session: e.sessionId,
            type: e.type,
            at: e.createdAt,
            summary: summarize(e.type, e.payload),
        }));
    }

    /** Run summaries: completed runs with their outcome. */
    runSummaries(namespace?: string): RunSummary[] {
        return this.state.list("Run", namespace).map((run) => ({
            name: nameOf(run),
            namespace: namespaceOf(run),
            agent: run.spec?.agentRef,
            phase: run.status?.phase ?? "unknown",
            startedAt: run.status?.startedAt,
            completedAt: run.status?.completedAt,
        }));
    }

    /** Approval queue: pending approvals awaiting human response. */
    approvalQueue(namespace?: string): ApprovalView[] {
        return this.state.list("Approval", namespace)
            .filter((a) => a.status?.phase === "requested")
            .map((a) => ({
                name: nameOf(a),
                namespace: namespaceOf(a),
                action: a.spec?.action,
                reason: a.spec?.reason,
                resource: a.spec?.resource,
                requestedBy: a.spec?.requestedBy,
                createdAt: a.status?.createdAt,
            }));
    }

    /** Schedule status: every schedule with its phase + next fire. */
    scheduleStatus(namespace?: string): ScheduleStatusView[] {
        return this.state.list("Schedule", namespace).map((s) => ({
            name: nameOf(s),
            namespace: namespaceOf(s),
            type: s.spec?.type,
            phase: s.status?.phase ?? "pending",
            lastFiredAt: s.status?.lastFiredAt ?? s.status?.firedAt,
            error: s.status?.error,
        }));
    }

    /** Listener status: every listener + its platform + phase. */
    listenerStatus(namespace?: string): ListenerStatusView[] {
        return this.state.list("Listener", namespace).map((l) => ({
            name: nameOf(l),
            namespace: namespaceOf(l),
            platform: l.spec?.platform ?? "cli",
            agent: l.spec?.agentRef,
            phase: l.status?.phase ?? "pending",
        }));
    }

    /** A full cluster snapshot for the control-room view. */
    async snapshot(namespace?: string): Promise<ClusterSnapshot> {
        return {
            agents: this.agentTree(namespace),
            runs: this.runSummaries(namespace),
            approvals: this.approvalQueue(namespace),
            schedules: this.scheduleStatus(namespace),
            listeners: this.listenerStatus(namespace),
            // Activity is session-scoped; the snapshot returns recent activity across all sessions.
            recentActivity: await this.activityTail(undefined, 20),
        };
    }
}

export type AgentTreeNode = {
    name: string;
    namespace: string;
    lifecycle: string;
    phase: string;
    brainPod?: string;
    session?: string;
    systemAgent: boolean;
};

export type ActivityEntry = {
    id: string;
    session: string;
    type: string;
    at: string;
    summary: string;
};

export type RunSummary = {
    name: string;
    namespace: string;
    agent?: string;
    phase: string;
    startedAt?: string;
    completedAt?: string;
};

export type ApprovalView = {
    name: string;
    namespace: string;
    action?: string;
    reason?: string;
    resource?: string;
    requestedBy?: string;
    createdAt?: string;
};

export type ScheduleStatusView = {
    name: string;
    namespace: string;
    type?: string;
    phase: string;
    lastFiredAt?: string;
    error?: string;
};

export type ListenerStatusView = {
    name: string;
    namespace: string;
    platform: string;
    agent?: string;
    phase: string;
};

export type ClusterSnapshot = {
    agents: AgentTreeNode[];
    runs: RunSummary[];
    approvals: ApprovalView[];
    schedules: ScheduleStatusView[];
    listeners: ListenerStatusView[];
    recentActivity: ActivityEntry[];
};

function summarize(type: string, payload: Record<string, any>): string {
    switch (type) {
        case "listener.message.received": return `message from ${payload.origin?.platform ?? "?"}`;
        case "brain.woke": return `brain woke (${payload.mode ?? "?"})`;
        case "brain.sleeping": return "brain sleeping";
        case "brain.model.completed": return `model completed (${payload.bytes ?? 0} bytes)`;
        case "home.file.written": return `wrote ${payload.path}`;
        case "tool.completed": return `tool ${payload.tool}`;
        case "tool.failed": return `tool ${payload.tool} failed (${payload.code})`;
        case "schedule.fired": return `schedule ${payload.schedule}`;
        case "agent.spawned": return `spawned ${payload.agent}`;
        case "agent.reaped": return `reaped ${payload.agent}`;
        case "approval.requested": return `approval ${payload.approval} (${payload.action})`;
        case "approval.responded": return `approval ${payload.approval} ${payload.decision}`;
        case "syscall.audited": return `${payload.who} -> ${payload.capability}`;
        case "system-agent.created": return `system agent ${payload.agent}`;
        default: return type;
    }
}

/**
 * A bounded ring buffer of recent events, maintained on event subscribe. Seed
 * from the durable log on start; push incrementally as events arrive. Reads are
 * O(limit) with no durable-log replay.
 */
class ActivityProjection {
    private events: import("../domain/events.js").HadesEvent[] = [];

    constructor(private readonly capacity: number) {}

    /** Replay the durable log into the buffer (called once on start). */
    seed(all: import("../domain/events.js").HadesEvent[]): void {
        this.events = all.slice(-this.capacity);
    }

    /** Push an appended event (called from the event-store subscriber). */
    push(event: import("../domain/events.js").HadesEvent): void {
        this.events.push(event);
        if (this.events.length > this.capacity) this.events.shift();
    }

    /** Return the last `limit` events, optionally filtered by session. */
    tail(sessionId: string | undefined, limit: number): import("../domain/events.js").HadesEvent[] {
        const filtered = sessionId
            ? this.events.filter((e) => e.sessionId === sessionId)
            : this.events;
        return filtered.slice(-limit);
    }
}

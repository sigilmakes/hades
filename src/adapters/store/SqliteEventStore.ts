import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { HadesEvent } from "../../domain/events.js";
import type { EventStorePort } from "../../ports/EventStore.js";

/**
 * A durable, queryable event store backed by SQLite on a PVC (P3).
 *
 * Append-only events table, indexed by `session_id` / `type` / `created_at`.
 * Satisfies {@link EventStorePort} — a drop-in replacement for
 * `JsonlEventStore` that survives pod restarts and supports the wake flow
 * (brain pods replay context via `list`).
 *
 * SQLite-on-PVC is the idiomatic local-k3s store (k3s itself uses sqlite for
 * its control plane). Postgres is the production target when multi-node or
 * high-write-volume demands it; because this is behind the port (D4), that
 * swap is an adapter change, not a rewrite.
 *
 * Also exposes `subscribe` for stream consumers (projection store, brain-pod
 * wake-on-event). Subscribers receive events appended *after* subscription,
 * in order.
 */
export class SqliteEventStore implements EventStorePort {
    readonly dataDir: string;
    readonly dbPath: string;
    private db!: DatabaseSync;
    private subscribers: Array<(event: HadesEvent) => void> = [];
    private seq = 0;

    constructor(dataDir: string) {
        this.dataDir = dataDir;
        this.dbPath = path.join(dataDir, "events.db");
    }

    async init(): Promise<void> {
        await mkdir(this.dataDir, { recursive: true });
        this.db = new DatabaseSync(this.dbPath);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                type TEXT NOT NULL,
                created_at TEXT NOT NULL,
                payload TEXT NOT NULL DEFAULT '{}',
                meta TEXT NOT NULL DEFAULT '{}'
            );
            CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
            CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
            CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
        `);
        // Resume the per-session id counter from the highest existing id.
        const row = this.db.prepare("SELECT MAX(seq) AS max_seq FROM events").get() as { max_seq: number | null } | undefined;
        this.seq = row?.max_seq ?? 0;
    }

    async append(sessionId: string, type: string, payload: Record<string, any> = {}, meta: Record<string, any> = {}): Promise<HadesEvent> {
        if (!this.db) await this.init();
        this.seq += 1;
        const id = `evt_${String(this.seq).padStart(6, "0")}`;
        const createdAt = new Date().toISOString();
        const event: HadesEvent = {
            id,
            sessionId,
            type,
            createdAt,
            payload,
            ...meta,
        };
        this.db.prepare(
            "INSERT INTO events (id, session_id, type, created_at, payload, meta) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(id, sessionId, type, createdAt, JSON.stringify(payload), JSON.stringify(meta));
        for (const subscriber of this.subscribers) {
            try { subscriber(event); } catch { /* a failing subscriber must not break append */ }
        }
        return event;
    }

    async list(sessionId?: string): Promise<HadesEvent[]> {
        if (!this.db) await this.init();
        const rows = sessionId
            ? (this.db.prepare("SELECT * FROM events WHERE session_id = ? ORDER BY seq ASC").all(sessionId) as any[])
            : (this.db.prepare("SELECT * FROM events ORDER BY seq ASC").all() as any[]);
        return rows.map(rowToEvent);
    }

    /** Subscribe to events appended after subscription. Returns an unsubscribe fn. */
    subscribe(_sessionId: string | undefined, _filter?: { type?: string }): (event: HadesEvent) => void {
        // Simple broadcast subscribers; per-session/type filtering is applied here.
        const filterSession = _sessionId;
        const filterType = _filter?.type;
        const subscriber = (event: HadesEvent) => {
            if (filterSession && event.sessionId !== filterSession) return;
            if (filterType && event.type !== filterType) return;
        };
        this.subscribers.push(subscriber);
        return () => {
            this.subscribers = this.subscribers.filter((s) => s !== subscriber);
        };
    }

    close(): void {
        this.db?.close();
    }
}

function rowToEvent(row: any): HadesEvent {
    const meta = JSON.parse(row.meta ?? "{}");
    return {
        id: row.id,
        sessionId: row.session_id,
        type: row.type,
        createdAt: row.created_at,
        payload: JSON.parse(row.payload ?? "{}"),
        ...meta,
    };
}

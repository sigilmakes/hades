import pg, { type Pool } from "pg";
import type { HadesEvent } from "../../domain/events.js";
import type { EventStorePort } from "../../ports/EventStore.js";

/**
 * A durable, queryable event store backed by Postgres — the production target.
 * Satisfies {@link EventStorePort}; a drop-in replacement for `SqliteEventStore`.
 *
 * Append-only `events` table, indexed by `session_id` / `type` / `created_at`.
 * Supports the wake flow (brain pods replay context via `list`) and `subscribe`
 * for projection consumers.
 *
 * Requires `DATABASE_URL` (or an injected `Pool`). The schema is created on
 * `init` if absent.
 */
export class PostgresEventStore implements EventStorePort {
    private readonly pool: Pool;
    private subscribers: Array<(event: HadesEvent) => void> = [];

    constructor(options: PostgresEventStoreOptions = {}) {
        this.pool = options.pool ?? new pg.Pool({ connectionString: process.env.DATABASE_URL });
    }

    async init(): Promise<void> {
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS events (
                id BIGSERIAL PRIMARY KEY,
                session_id TEXT NOT NULL,
                type TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                payload JSONB NOT NULL DEFAULT '{}',
                meta JSONB NOT NULL DEFAULT '{}'
            );
            CREATE INDEX IF NOT EXISTS idx_events_session ON events (session_id, id);
            CREATE INDEX IF NOT EXISTS idx_events_type ON events (type, id);
        `);
    }

    async append(sessionId: string, type: string, payload: Record<string, any> = {}, meta: Record<string, any> = {}): Promise<HadesEvent> {
        const result = await this.pool.query(
            `INSERT INTO events (session_id, type, payload, meta) VALUES ($1, $2, $3, $4)
             RETURNING id, session_id, type, created_at, payload, meta`,
            [sessionId, type, JSON.stringify(payload), JSON.stringify(meta)],
        );
        const row = result.rows[0] as { id: string; session_id: string; type: string; created_at: Date; payload: HadesEvent["payload"]; meta: Record<string, any> };
        const event: HadesEvent = {
            id: `evt_${row.id}`,
            sessionId: row.session_id,
            type: row.type,
            createdAt: row.created_at.toISOString(),
            payload: row.payload,
            ...row.meta,
        };
        for (const subscriber of this.subscribers) {
            try { subscriber(event); } catch { /* a failing subscriber must not break append */ }
        }
        return event;
    }

    async list(sessionId?: string): Promise<HadesEvent[]> {
        const result = sessionId
            ? await this.pool.query("SELECT id, session_id, type, created_at, payload, meta FROM events WHERE session_id = $1 ORDER BY id", [sessionId])
            : await this.pool.query("SELECT id, session_id, type, created_at, payload, meta FROM events ORDER BY id");
        return (result.rows as Array<{ id: string; session_id: string; type: string; created_at: Date; payload: HadesEvent["payload"]; meta: Record<string, any> }>).map((row) => ({
            id: `evt_${row.id}`,
            sessionId: row.session_id,
            type: row.type,
            createdAt: row.created_at.toISOString(),
            payload: row.payload,
            ...row.meta,
        }));
    }

    subscribe(handler: (event: HadesEvent) => void): () => void {
        this.subscribers.push(handler);
        return () => {
            this.subscribers = this.subscribers.filter((s) => s !== handler);
        };
    }

    async close(): Promise<void> {
        await this.pool.end();
    }
}

export type PostgresEventStoreOptions = {
    pool?: Pool;
};

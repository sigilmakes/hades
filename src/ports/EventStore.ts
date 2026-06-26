import type { HadesEvent } from "../domain/events.js";

export interface EventStorePort {
    init(): Promise<void>;
    append(sessionId: string, type: string, payload?: Record<string, any>, meta?: Record<string, any>): Promise<HadesEvent>;
    list(sessionId?: string): Promise<HadesEvent[]>;
    /** Stream events appended after subscription. Returns an unsubscribe fn. */
    subscribe?(handler: (event: HadesEvent) => void): () => void;
    /** Release resources (DB handles). Optional; no-op for in-memory stores. */
    close?(): Promise<void>;
}

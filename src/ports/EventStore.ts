import type { HadesEvent } from "../domain/events.js";

export interface EventStorePort {
    init(): Promise<void>;
    append(sessionId: string, type: string, payload?: Record<string, any>, meta?: Record<string, any>): Promise<HadesEvent>;
    list(sessionId?: string): Promise<HadesEvent[]>;
}

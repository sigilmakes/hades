export type HadesEvent = {
    id: string;
    sessionId: string;
    type: string;
    createdAt: string;
    payload: Record<string, unknown>;
    /** Event-specific meta fields (traceId, causality, etc.) merged into the event. */
    [key: string]: unknown;
};

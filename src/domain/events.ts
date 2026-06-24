export type HadesEvent = {
    id: string;
    sessionId: string;
    type: string;
    createdAt: string;
    payload: Record<string, any>;
    [key: string]: any;
};

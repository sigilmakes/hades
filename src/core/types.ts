export type Metadata = {
    namespace?: string;
    name: string;
};

export type HadesResource = {
    apiVersion?: string;
    kind: string;
    metadata?: Metadata;
    spec?: Record<string, any>;
    status?: Record<string, any>;
};

export type AgentSubject = {
    kind: string;
    name: string;
    namespace: string;
};

export type ToolResult = {
    code: number;
    signal?: NodeJS.Signals | string | null;
    stdout: string;
    stderr: string;
};

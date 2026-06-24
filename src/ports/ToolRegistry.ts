export type ToolCallResult = {
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, any>;
};

export interface ToolRegistryPort {
    registerHadesTools(api: unknown): void;
}

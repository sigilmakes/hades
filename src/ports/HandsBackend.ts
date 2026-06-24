import type { ToolResult } from "../domain/resources.js";

export type ExecRequest = {
    command: string;
    cwd?: string;
};

export interface HandsBackend {
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<{ path: string; bytes: number }>;
    exec(request: ExecRequest): Promise<ToolResult>;
}

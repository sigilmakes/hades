import type { HandsBackend } from "../../ports/HandsBackend.js";

type PiToolApi = {
    registerTool(tool: unknown): void;
};

type ToolFactory = (definition: unknown) => unknown;

type TypeApi = {
    Object(schema: Record<string, unknown>): unknown;
    String(): unknown;
    Optional(value: unknown): unknown;
};

export class HadesToolRegistrar {
    constructor(
        private readonly hands: HandsBackend,
        private readonly defineTool: ToolFactory,
        private readonly Type: TypeApi,
    ) {}

    register(api: PiToolApi): void {
        api.registerTool(this.defineTool({
            name: "hades_read",
            label: "Hades Read",
            description: "Read a file from the agent Home through Hades Hands.",
            parameters: this.Type.Object({ path: this.Type.String() }),
            execute: async (_id: string, params: { path: string }) => ({
                content: [{ type: "text", text: await this.hands.read(params.path) }],
                details: { path: params.path },
            }),
        }));
        api.registerTool(this.defineTool({
            name: "hades_write",
            label: "Hades Write",
            description: "Write a file in the agent Home through Hades Hands.",
            parameters: this.Type.Object({ path: this.Type.String(), content: this.Type.String() }),
            execute: async (_id: string, params: { path: string; content: string }) => {
                const result = await this.hands.write(params.path, params.content);
                return { content: [{ type: "text", text: `wrote ${result.path} (${result.bytes} bytes)` }], details: result };
            },
        }));
        api.registerTool(this.defineTool({
            name: "hades_exec",
            label: "Hades Exec",
            description: "Run a confined Home-relative executable through Hades Hands.",
            parameters: this.Type.Object({ command: this.Type.String(), cwd: this.Type.Optional(this.Type.String()) }),
            execute: async (_id: string, params: { command: string; cwd?: string }) => {
                const result = await this.hands.exec({ command: params.command, cwd: params.cwd ?? "." });
                return { content: [{ type: "text", text: result.stdout || result.stderr || `exit ${result.code}` }], details: result };
            },
        }));
    }
}

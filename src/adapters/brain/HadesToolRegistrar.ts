import type { HandsBackend } from "../../ports/HandsBackend.js";

/** A kernel syscall endpoint the brain calls to mutate Hades resources
 * (e.g. install packages). Injected so tests can stub it. */
export interface SyscallEndpoint {
    installPackages(subject: { kind: string; name: string; namespace: string }, spec: { packages: string[]; name?: string }): Promise<unknown>;
}

type PiToolApi = {
    registerTool(tool: unknown): void;
};

type ToolFactory = (definition: unknown) => unknown;

type TypeApi = {
    Object(schema: Record<string, unknown>): unknown;
    String(): unknown;
    Array(value: unknown): unknown;
    Optional(value: unknown): unknown;
};

export class HadesToolRegistrar {
    constructor(
        private readonly hands: HandsBackend,
        private readonly defineTool: ToolFactory,
        private readonly Type: TypeApi,
        /** The agent's identity + a syscall endpoint for hades_install. */
        private readonly self?: { subject: { kind: string; name: string; namespace: string }; syscalls: SyscallEndpoint },
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
        // hades_install — declare Nix packages for the agent's hands image + rebuild.
        if (this.self) {
            api.registerTool(this.defineTool({
                name: "hades_install",
                label: "Hades Install Packages",
                description: "Declare Nix packages for this agent's hands image and trigger a rebuild. The new image rolls onto the hands pod.",
                parameters: this.Type.Object({ packages: this.Type.Array(this.Type.String()) }),
                execute: async (_id: string, params: { packages: string[] }) => {
                    const image = await this.self.syscalls.installPackages(this.self.subject, { packages: params.packages }) as { metadata?: { name?: string }; spec?: { packages?: string[] } };
                    return { content: [{ type: "text", text: `requested hands image rebuild with: ${params.packages.join(", ")}` }], details: { image: image?.metadata?.name, packages: image?.spec?.packages } };
                },
            }));
        }
    }
}

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { LocalConfinedHands } from "../adapters/hands/LocalConfinedHands.js";
import { CONFINED_PROFILE, type SandboxProfile } from "../domain/sandbox.js";
import type { HandsBackend } from "../ports/HandsBackend.js";
import type { ExecRequest } from "../ports/HandsBackend.js";

/**
 * The hands pod: an MCP server (Streamable HTTP transport) exposing the
 * `hades_read`/`hades_write`/`hades_exec` tools over a single HTTP endpoint
 * (D2: brain→hands = MCP Streamable HTTP, the standards-aligned wire).
 *
 * The confinement logic is the *exact* code from `LocalConfinedHands` /
 * `HomePathPolicy` / `ConfinedCommandParser` / `src/domain/sandbox.ts`. MCP is
 * the transport; the sandbox profile is still what decides if `exec` is
 * allowed. A container-backed hands pod (future) swaps the profile, not the
 * wire.
 *
 * Runs **stateless** (no session ID) — each tool call is independent, which
 * suits disposable hands. Per the MCP stateless contract, a fresh transport is
 * created per request (the transport cannot be reused across requests in
 * stateless mode). The {@link McpServer} tool registrations are rebuilt per
 * request from the same backing {@link HandsBackend}; this is cheap and keeps
 * each request fully independent.
 *
 * Mount point: `POST/GET/DELETE /mcp` (the MCP endpoint), plus `GET /healthz`.
 *
 * Home is mounted as a PVC (D3); the path is `HADES_HOME_ROOT` (default
 * `/home/agent`). Model credentials never live here (Managed Agents token
 * isolation).
 */
export class HandsPod {
    readonly server: http.Server;
    private readonly hands: HandsBackend;
    private readonly homeRoot: string;
    private readonly profile: SandboxProfile;

    constructor(options: HandsPodOptions = {}) {
        this.homeRoot = options.homeRoot ?? process.env.HADES_HOME_ROOT ?? "/home/agent";
        this.profile = options.profile ?? CONFINED_PROFILE;
        this.hands = options.hands ?? new LocalConfinedHands({ homeRoot: this.homeRoot, profile: this.profile });
        this.server = http.createServer((req, res) => this.handle(req, res));
    }

    listen(port: number, callback?: () => void): this {
        this.server.listen(port, callback);
        return this;
    }

    async close(): Promise<void> {
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }

    /** Build a fresh stateless transport + connected MCP server for one request. */
    private async transportForRequest(): Promise<StreamableHTTPServerTransport> {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const mcp = new McpServer(
            { name: "hades-hands", version: "0.1.0" },
            { capabilities: { tools: {} } },
        );
        this.registerTools(mcp);
        await mcp.connect(transport);
        return transport;
    }

    private registerTools(mcp: McpServer): void {
        mcp.registerTool(
            "hades_read",
            {
                title: "Hades Read",
                description: "Read a file from the agent Home through Hades Hands.",
                inputSchema: { path: z.string() },
            },
            async ({ path }) => {
                const content = await this.hands.read(path);
                return { content: [{ type: "text", text: content }] };
            },
        );
        mcp.registerTool(
            "hades_write",
            {
                title: "Hades Write",
                description: "Write a file in the agent Home through Hades Hands.",
                inputSchema: { path: z.string(), content: z.string() },
            },
            async ({ path, content }) => {
                const result = await this.hands.write(path, content);
                return { content: [{ type: "text", text: `wrote ${result.path} (${result.bytes} bytes)` }] };
            },
        );
        mcp.registerTool(
            "hades_exec",
            {
                title: "Hades Exec",
                description: "Run a confined Home-relative executable through Hades Hands.",
                inputSchema: { command: z.string(), cwd: z.string().optional() },
            },
            async ({ command, cwd }) => {
                const req: ExecRequest = { command, cwd: cwd ?? "." };
                const result = await this.hands.exec(req);
                return { content: [{ type: "text", text: result.stdout || result.stderr || `exit ${result.code}` }] };
            },
        );
    }

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (req.method === "GET" && url.pathname === "/healthz") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, mode: "hands-pod", wire: "mcp-streamable-http" }));
            return;
        }
        // MCP endpoint: POST/GET/DELETE /mcp — fresh stateless transport per request.
        if (url.pathname === "/mcp") {
            const transport = await this.transportForRequest();
            // The transport's lifecycle is tied to this response; Node closes the
            // socket when the response ends. Do not close eagerly — that would
            // cut off the SSE stream before the client reads it.
            await transport.handleRequest(req, res);
            return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
    }
}

export type HandsPodOptions = {
    homeRoot?: string;
    profile?: SandboxProfile;
    hands?: HandsBackend;
};

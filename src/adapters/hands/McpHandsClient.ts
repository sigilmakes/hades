import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolResult } from "../../domain/resources.js";
import type { ExecRequest, HandsBackend } from "../../ports/HandsBackend.js";

/**
 * A {@link HandsBackend} that calls a hands pod's tools over MCP Streamable
 * HTTP — the standards-aligned brain→hands wire. This is the deploy-mode
 * replacement for the in-process `LocalConfinedHands`.
 *
 * The client is lazy: it connects on first use and reuses the session. The
 * hands pod exposes `hades_read`/`hades_write`/`hades_exec` as MCP tools; this
 * client maps the {@link HandsBackend} interface onto `tools/call`.
 *
 * `HADES_HANDS_URL` (or the constructor arg) is the hands pod MCP endpoint,
 * e.g. `http://hands-atlas.hades.svc.cluster.local/mcp`.
 */
export class McpHandsClient implements HandsBackend {
    readonly mode = "mcp";
    private readonly endpoint: string;
    private client?: Client;
    private transport?: StreamableHTTPClientTransport;

    constructor(baseUrl: string = process.env.HADES_HANDS_URL ?? "http://127.0.0.1:7350") {
        const base = baseUrl.replace(/\/+$/, "");
        this.endpoint = base.endsWith("/mcp") ? base : `${base}/mcp`;
    }

    async read(path: string): Promise<string> {
        const result = await this.call("hades_read", { path });
        return textOf(result);
    }

    async write(path: string, content: string): Promise<{ path: string; bytes: number }> {
        const result = await this.call("hades_write", { path, content });
        const text = textOf(result);
        // The server reports "wrote <path> (<bytes> bytes)"; parse for the shape.
        const match = text.match(/wrote (\S+) \((\d+) bytes\)/);
        if (match) return { path: match[1], bytes: Number(match[2]) };
        return { path, bytes: content.length };
    }

    async exec(request: ExecRequest): Promise<ToolResult> {
        const result = await this.call("hades_exec", { command: request.command, cwd: request.cwd ?? "." });
        const text = textOf(result);
        // The server surfaces stdout||stderr||`exit <code>`; map back to ToolResult.
        const exitMatch = text.match(/^exit (\d+)$/);
        if (exitMatch) return { code: Number(exitMatch[1]), signal: null, stdout: "", stderr: "" };
        return { code: 0, signal: null, stdout: text, stderr: "" };
    }

    async close(): Promise<void> {
        await this.transport?.close();
        this.client = undefined;
        this.transport = undefined;
    }

    private async call(name: string, args: Record<string, unknown>): Promise<{ content?: Array<{ type: string; text?: string }> }> {
        const client = await this.ensureConnected();
        const result = await client.callTool({ name, arguments: args });
        const typed = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
        // MCP surfaces tool exceptions as isError results, not thrown errors.
        // Re-surface as a rejection so the HandsBackend contract (throw on
        // confinement failure) holds over the wire.
        if (typed.isError) {
            const text = textOf(typed);
            throw new Error(text || `hands tool ${name} failed`);
        }
        return typed;
    }

    private async ensureConnected(): Promise<Client> {
        if (this.client) return this.client;
        this.transport = new StreamableHTTPClientTransport(new URL(this.endpoint));
        this.client = new Client({ name: "hades-brain", version: "0.1.0" }, { capabilities: {} });
        await this.client.connect(this.transport);
        return this.client;
    }
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
    const block = result.content?.find((c) => c.type === "text");
    return block?.text ?? "";
}

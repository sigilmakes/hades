import type { ToolResult } from "../../domain/resources.js";
import type { ExecRequest, HandsBackend } from "../../ports/HandsBackend.js";

/**
 * A {@link HandsBackend} that routes `hades_read`/`hades_write`/`hades_exec` to
 * a hands endpoint over plain HTTP/JSON (`POST /read`, `/write`, `/exec`).
 *
 * Kept as a simple fallback to the MCP Streamable HTTP wire (`McpHandsClient`).
 * The brain pod prefers MCP by default; this client is useful for diagnostics
 * and environments without the MCP SDK.
 *
 * `HADES_HANDS_URL` (or the constructor arg) is the hands pod base URL, e.g.
 * `http://hands-atlas.hades.svc.cluster.local`.
 */
export class HttpHandsClient implements HandsBackend {
    readonly mode = "http";
    private readonly baseUrl: string;

    constructor(baseUrl: string = process.env.HADES_HANDS_URL ?? "http://127.0.0.1:7348") {
        if (!baseUrl) throw new Error("HttpHandsClient requires a hands base URL (HADES_HANDS_URL)");
        this.baseUrl = baseUrl.replace(/\/+$/, "");
    }

    async read(path: string): Promise<string> {
        const res = await this.post("/read", { path });
        const body = (await res.json()) as { content?: string; error?: string };
        if (!res.ok) throw new Error(`hands read failed (${res.status}): ${body.error ?? res.statusText}`);
        return String(body.content ?? "");
    }

    async write(path: string, content: string): Promise<{ path: string; bytes: number }> {
        const res = await this.post("/write", { path, content });
        const body = (await res.json()) as { path?: string; bytes?: number; error?: string };
        if (!res.ok) throw new Error(`hands write failed (${res.status}): ${body.error ?? res.statusText}`);
        return { path: String(body.path), bytes: Number(body.bytes ?? 0) };
    }

    async exec(request: ExecRequest): Promise<ToolResult> {
        const res = await this.post("/exec", request);
        const body = (await res.json()) as { code?: number; signal?: string | null; stdout?: string; stderr?: string; error?: string };
        if (!res.ok) throw new Error(`hands exec failed (${res.status}): ${body.error ?? res.statusText}`);
        return {
            code: Number(body.code ?? 0),
            signal: body.signal ?? null,
            stdout: String(body.stdout ?? ""),
            stderr: String(body.stderr ?? ""),
        };
    }

    private post(path: string, body: unknown): Promise<Response> {
        return fetch(`${this.baseUrl}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
    }
}

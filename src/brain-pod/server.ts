import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { nameOf, type HadesResource } from "../domain/resources.js";
import type { BrainDriver, BrainRunInput } from "../ports/BrainDriver.js";
import type { EventStorePort } from "../ports/EventStore.js";
import type { HandsBackend } from "../ports/HandsBackend.js";
import { PiSdkBrainDriver } from "../adapters/brain/PiSdkBrainDriver.js";
import { HttpHandsClient } from "../adapters/hands/HttpHandsClient.js";
import { McpHandsClient } from "../adapters/hands/McpHandsClient.js";

/**
 * The brain pod HTTP server.
 *
 * Lifts the model/harness loop out of the parent process into its own pod
 * (P1). The brain pod embeds a pi SDK `AgentSession` — the *exact* code in
 * `PiSdkBrainDriver.run` — wrapped in an HTTP server exposing `POST /run`.
 * Tool calls route over HTTP to a hands endpoint (P1: `HttpHandsClient`;
 * P2: MCP Streamable HTTP). The model loop code does not change; only the
 * transport does.
 *
 * Wire protocol (parent → brain), plain HTTP/JSON + SSE (D2):
 *   POST /run { agent, session, prompt }
 *     -> SSE stream: { type: "token", delta } ... { type: "done", reply }
 *     -> on error:   { type: "error", message }
 *
 * The parent is an orchestrator, not a tool client, so this is NOT MCP —
 * it's a thin run/stream wire. The brain→hands tool layer is the MCP path.
 */
export class BrainPod {
    readonly server: http.Server;
    private readonly driver: BrainDriver;

    constructor(options: BrainPodOptions) {
        // Prefer MCP Streamable HTTP (D2, the standards-aligned wire) when a hands
        // URL is set; fall back to plain-HTTP hands for P1 compatibility.
        const hands = options.hands ?? defaultHandsFromEnv();
        const events = options.events ?? noopEventStore;
        const homeRoot = options.homeRoot ?? process.env.HADES_HOME_ROOT ?? "/home/agent";
        this.driver = options.driver ?? defaultDriver(options.mode ?? "pi-sdk", events, hands, homeRoot);
        this.server = http.createServer((req, res) => this.handle(req, res));
    }

    listen(port: number, callback?: () => void): this {
        this.server.listen(port, callback);
        return this;
    }

    async close(): Promise<void> {
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        try {
            const url = new URL(req.url ?? "/", "http://localhost");
            if (req.method === "GET" && url.pathname === "/healthz") return json(res, { ok: true, mode: "brain-pod" });
            if (req.method === "POST" && url.pathname === "/run") return this.run(await readBody(req), res);
            return json(res, { error: "not found" }, 404);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return json(res, { error: message }, 500);
        }
    }

    private async run(body: BrainRunInput, res: ServerResponse): Promise<void> {
        res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
        });
        const send = (event: Record<string, unknown>) => {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        try {
            const reply = await this.driver.run(body);
            send({ type: "done", reply });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            send({ type: "error", message });
        } finally {
            res.end();
        }
    }
}

function defaultDriver(mode: string, events: EventStorePort, hands: HandsBackend, homeRoot: string): BrainDriver {
    if (mode === "test") return new BrainPodTestDriver(events, hands);
    if (mode === "pi-sdk") return new PiSdkBrainDriver(events, () => homeRoot, () => hands);
    throw new Error(`Unknown brain mode ${mode}`);
}

/**
 * A minimal test driver for the brain pod: interprets only the `!read`/`!write`/`!exec`
 * directives so P1 can prove tool calls route over HTTP to the hands endpoint.
 * Schedules and spawn are kernel-side concerns, not brain-pod concerns — the
 * full {@link TestBrainDriver} with those directives lives in the parent/dev mode.
 */
class BrainPodTestDriver implements BrainDriver {
    readonly mode = "test";
    constructor(private readonly events: EventStorePort, private readonly hands: HandsBackend) {}
    async run({ agent, session, prompt }: BrainRunInput): Promise<string> {
        const sessionName = nameOf(session);
        const trimmed = prompt.trim();
        let reply: string;
        try {
            if (trimmed.startsWith("!write ")) {
                const match = trimmed.match(/^!write\s+([\s\S]+)$/);
                if (!match) throw new Error("write directive format: !write <path> <<< <content>");
                const [file, content = ""] = match[1].split("<<<");
                const result = await this.hands.write(file.trim(), content.trimStart());
                reply = `wrote ${result.path} (${result.bytes} bytes)`;
            } else if (trimmed.startsWith("!read ")) {
                reply = await this.hands.read(trimmed.replace(/^!read\s+/, "").trim());
            } else if (trimmed.startsWith("!exec ")) {
                const result = await this.hands.exec({ command: trimmed.replace(/^!exec\s+/, "") });
                reply = result.stdout || result.stderr || `exit ${result.code}`;
            } else if (trimmed.startsWith("!")) {
                throw new Error(`Unsupported brain-pod directive: ${trimmed.split(/\s+/, 1)[0]}`);
            } else {
                reply = `${agent.spec?.displayName ?? nameOf(agent)} received: ${prompt}`;
            }
            await this.events.append(sessionName, "brain.model.completed", { provider: "test", bytes: reply.length });
            await this.events.append(sessionName, "agent.message", { agent: nameOf(agent), text: reply });
            await this.events.append(sessionName, "brain.sleeping", { checkpoint: "latest" });
            return reply;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.events.append(sessionName, "brain.failed", { message });
            throw error;
        }
    }
}

export type BrainPodOptions = {
    mode?: string;
    hands?: HandsBackend;
    events?: EventStorePort;
    homeRoot?: string;
    driver?: BrainDriver;
};

function json(res: ServerResponse, value: unknown, status = 200): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
}

function readBody(req: IncomingMessage): Promise<BrainRunInput> {
    return new Promise((resolve, reject) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("error", reject);
        req.on("end", () => {
            try {
                resolve(JSON.parse(raw));
            } catch (error) {
                reject(error);
            }
        });
    });
}

const noopEventStore: EventStorePort = {
    init: async () => {},
    append: async (_sessionId, type, payload = {}, meta = {}) => ({ id: "evt_brain_pod", sessionId: "brain-pod", type, createdAt: new Date().toISOString(), payload, ...meta }),
    list: async () => [],
};

/**
 * Resolve the hands backend from env. Prefers MCP Streamable HTTP (D2) when
 * `HADES_HANDS_URL` is set; otherwise returns a stub that fails on use (not
 * on construction) so health/404 checks work without a hands endpoint.
 * Override by passing `hands` to {@link BrainPodOptions}.
 */
function defaultHandsFromEnv(): HandsBackend {
    const url = process.env.HADES_HANDS_URL;
    if (!url) return new UnconfiguredHands();
    return new McpHandsClient(url);
}

/** A hands backend that fails loudly on use when no hands endpoint is configured. */
class UnconfiguredHands implements HandsBackend {
    readonly mode = "unconfigured";
    private fail(): never {
        throw new Error("brain pod requires HADES_HANDS_URL (the hands pod endpoint) or an injected hands backend");
    }
    async read(): Promise<string> { this.fail(); }
    async write(): Promise<{ path: string; bytes: number }> { this.fail(); }
    async exec(): Promise<import("../domain/resources.js").ToolResult> { this.fail(); }
}

export { nameOf };
export type { HadesResource };

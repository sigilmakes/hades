import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { nameOf, type HadesResource } from "../domain/resources.js";
import type { BrainDriver, BrainRunInput } from "../ports/BrainDriver.js";
import type { EventStorePort } from "../ports/EventStore.js";
import type { HandsBackend } from "../ports/HandsBackend.js";
import { PiSdkBrainDriver } from "../adapters/brain/PiSdkBrainDriver.js";
import { McpHandsClient } from "../adapters/hands/McpHandsClient.js";
import { PodHandsBackend, handsPodName } from "../adapters/hands/PodHandsBackend.js";
import { KubeClientNode } from "../adapters/kube/KubeClientNode.js";

/**
 * The brain pod HTTP server.
 *
 * Lifts the model/harness loop out of the parent process into its own pod.
 * The brain pod embeds a pi SDK `AgentSession` — the *exact* code in
 * `PiSdkBrainDriver.run` — wrapped in an HTTP server exposing `POST /run`.
 * Tool calls exec into the agent's hands pod via the k8s API
 * (`PodHandsBackend`); the hands pod is a thin sandbox the controller
 * provisions. The model loop code does not change; only the transport does.
 *
 * Wire protocol (parent → brain): plain HTTP/JSON + SSE — the parent is an
 * orchestrator, not a tool client, so this is a thin run/stream wire, not MCP.
 * The brain→hands tool layer is k8s exec.
 */
export class BrainPod {
    readonly server: http.Server;
    private readonly driver: BrainDriver;

    constructor(options: BrainPodOptions) {
        // The brain execs into the agent's hands pod via the k8s API by default.
        // MCP over HTTP is an explicit opt-in (HADES_HANDS_URL) for alternate
        // hands deployments.
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
 * directives so tool calls route over HTTP to the hands endpoint. Schedules and
 * spawn are kernel-side concerns, not brain-pod concerns — the full
 * {@link TestBrainDriver} with those directives lives in the parent/dev mode.
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
 * Resolve the hands backend from env.
 *
 * Default: build a {@link PodHandsBackend} that execs into the agent's hands
 * pod. The controller sets `HADES_AGENT_NAME` + `HADES_AGENT_NAMESPACE` on the
 * brain pod; the in-cluster ServiceAccount must be permitted `pods/exec`.
 *
 * Alternate: set `HADES_HANDS_URL` to route tool calls to an MCP hands pod
 * instead (a different deployment shape). Override entirely by passing
 * `hands` to {@link BrainPodOptions}.
 *
 * Resolution is **lazy**: the real backend is built on first use, so the brain
 * pod can boot (and answer /healthz) before the agent env is meaningful, and
 * tests that never touch hands don't need a cluster.
 */
function defaultHandsFromEnv(): HandsBackend {
    return new LazyHands();
}

/**
 * A hands backend that resolves the real adapter on first use. Keeps the brain
 * pod bootable without a cluster (health checks, tests that skip tools).
 */
class LazyHands implements HandsBackend {
    readonly mode = "lazy";
    private real?: HandsBackend;

    private resolve(): HandsBackend {
        if (this.real) return this.real;
        const mcpUrl = process.env.HADES_HANDS_URL;
        if (mcpUrl) { this.real = new McpHandsClient(mcpUrl); return this.real; }
        const agentName = process.env.HADES_AGENT_NAME;
        const namespace = process.env.HADES_AGENT_NAMESPACE ?? "default";
        if (!agentName) {
            throw new Error("brain pod requires HADES_AGENT_NAME (+ HADES_AGENT_NAMESPACE) to exec into a hands pod, or HADES_HANDS_URL for the MCP wire");
        }
        // The brain pod runs with an in-cluster ServiceAccount; KubeClientNode
        // loads the SA config. Tests inject `hands` and never reach here.
        this.real = new PodHandsBackend({
            homeRoot: process.env.HADES_HOME_ROOT ?? "/home/agent",
            kubeClient: new KubeClientNode(),
            namespace,
            pod: handsPodName({ kind: "Agent", metadata: { name: agentName, namespace } }),
        });
        return this.real;
    }

    async read(path: string): Promise<string> { return this.resolve().read(path); }
    async write(path: string, content: string): Promise<{ path: string; bytes: number }> { return this.resolve().write(path, content); }
    async exec(request: import("../ports/HandsBackend.js").ExecRequest): Promise<import("../domain/resources.js").ToolResult> { return this.resolve().exec(request); }
}

export { nameOf };
export type { HadesResource };

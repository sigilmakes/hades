import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { parsePrimitiveDecision } from "../../domain/primitives.js";
import type { Runtime } from "../../runtime/Runtime.js";
import type { PolicyDecision } from "../../domain/capabilities.js";
import { createStaticHandler } from "./static.js";

/** A request handler: given the parsed body + URL, return a JSON-serializable result (or throw). */
type Handler = (ctx: RequestContext) => Promise<unknown> | unknown;

/** Sentinel a handler returns when it has written the response itself (e.g. SSE). */
export const STREAMING = Symbol("hades.streaming");

type RequestContext = {
    url: URL;
    body: Record<string, unknown>;
    /** Path params extracted by the matcher (e.g. /agents/:name/message -> { name }). */
    params: Record<string, string>;
    /** The raw response, for handlers that stream directly (SSE). */
    res: ServerResponse;
    /** The raw request, for handlers that need close events (SSE lifetime). */
    req: IncomingMessage;
};

type Route = {
    method: string;
    /** A literal path, or a path with :param segments (e.g. /agents/:name/message). */
    path: string;
    handler: Handler;
};

/**
 * Match a route against a method + pathname. Returns the route + extracted
 * params, or undefined. Literal paths match exactly; `:seg` captures a segment.
 */
function match(method: string, pathname: string, routes: Route[]): { route: Route; params: Record<string, string> } | undefined {
    const segments = pathname.split("/").filter(Boolean);
    for (const route of routes) {
        if (route.method !== method) continue;
        const routeSegments = route.path.split("/").filter(Boolean);
        if (routeSegments.length !== segments.length) continue;
        const params: Record<string, string> = {};
        let ok = true;
        for (let i = 0; i < routeSegments.length; i++) {
            const rs = routeSegments[i];
            const actual = segments[i];
            if (rs.startsWith(":")) params[rs.slice(1)] = actual;
            else if (rs !== actual) { ok = false; break; }
        }
        if (ok) return { route, params };
    }
    return undefined;
}

/** Build the route table for a runtime. */
function routes(runtime: Runtime): Route[] {
    const s = runtime.syscalls;
    const p = runtime.projections;
    return [
        { method: "GET", path: "/healthz", handler: () => ({ ok: true }) },
        { method: "GET", path: "/readyz", handler: () => (runtime.ready ? { ok: true } : { __status: 503, body: { ok: false, reason: "not initialized" } }) },
        {
            // Prometheus exposition: reconcile counts/errors/latency + pod phases.
            // Kernel self-report (the control plane observing itself), like /proc.
            method: "GET", path: "/metrics", handler: (c) => {
                const body = runtime.metrics.render();
                c.res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
                c.res.end(body);
                return STREAMING;
            },
        },
        { method: "GET", path: "/hades/v1/agents", handler: () => runtime.state.list("Agent") },
        { method: "GET", path: "/hades/v1/events", handler: (c) => runtime.events.list(c.url.searchParams.get("session") ?? undefined) },
        {
            method: "GET", path: "/hades/v1/events/stream", handler: (c) => {
                if (!runtime.events.subscribe) return { __status: 503, body: { error: "streaming unsupported by this store" } };
                const res = c.res;
                res.writeHead(200, {
                    "content-type": "text/event-stream",
                    "cache-control": "no-cache",
                    connection: "keep-alive",
                });
                // Replay recent history so a freshly-opened stream sees context, then stream live.
                runtime.events.list(c.url.searchParams.get("session") ?? undefined)
                    .then((history) => {
                        for (const evt of history) res.write(`data: ${JSON.stringify(evt)}\n\n`);
                        const unsub = runtime.events.subscribe!((evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`));
                        c.req.on("close", unsub);
                    })
                    .catch((e) => res.write(`data: ${JSON.stringify({ error: String(e) })}\n\n`));
                return STREAMING;
            },
        },
        { method: "GET", path: "/hades/v1/state", handler: () => runtime.snapshot() },
        { method: "GET", path: "/hades/v1/projections/agents", handler: (c) => p.agentTree(c.url.searchParams.get("namespace") ?? undefined) },
        { method: "GET", path: "/hades/v1/projections/activity", handler: (c) => p.activityTail(c.url.searchParams.get("session") ?? undefined, Number(c.url.searchParams.get("limit") ?? 50)) },
        { method: "GET", path: "/hades/v1/projections/approvals", handler: (c) => p.approvalQueue(c.url.searchParams.get("namespace") ?? undefined) },
        { method: "GET", path: "/hades/v1/projections/schedules", handler: (c) => p.scheduleStatus(c.url.searchParams.get("namespace") ?? undefined) },
        { method: "GET", path: "/hades/v1/projections/listeners", handler: (c) => p.listenerStatus(c.url.searchParams.get("namespace") ?? undefined) },
        { method: "GET", path: "/hades/v1/projections/snapshot", handler: (c) => p.snapshot(c.url.searchParams.get("namespace") ?? undefined) },
        {
            method: "GET", path: "/hades/v1/templates", handler: async () =>
                ({ templates: await runtime.templates.list() }),
        },
        {
            method: "POST", path: "/hades/v1/templates/:tpl/apply", handler: async (c) => {
                const name = c.body.name;
                if (typeof name !== "string") throw new ClientError("body.name required", 400);
                const ns = typeof c.body.namespace === "string" ? c.body.namespace : "default";
                const vars: Record<string, string> = {};
                if (c.body.vars && typeof c.body.vars === "object") {
                    for (const [k, v] of Object.entries(c.body.vars as Record<string, unknown>)) {
                        if (typeof v === "string") vars[k] = v;
                    }
                }
                const resources = await runtime.templates.render(c.params.tpl, name, ns, vars);
                for (const r of resources) await runtime.apply(r);
                await runtime.reconcile();
                return { applied: resources.length, resources };
            },
        },
        {
            method: "GET", path: "/hades/v1/primitives", handler: (c) => {
                let decision;
                try { decision = parsePrimitiveDecision(c.url.searchParams.get("decision") ?? undefined); }
                catch (e) { throw new ClientError(e instanceof Error ? e.message : String(e), 400); }
                return runtime.primitives.list(decision);
            },
        },
        { method: "POST", path: "/hades/v1/reconcile", handler: async () => { await runtime.reconcile(); return { ok: true }; } },
        {
            method: "POST", path: "/hades/v1/agents/:name/message", handler: async (c) => {
                const body = c.body;
                return runtime.messageAgent(c.params.name, String(body.text ?? ""), {
                    namespace: typeof body.namespace === "string" ? body.namespace : undefined,
                    origin: typeof body.origin === "object" && body.origin ? body.origin as Record<string, unknown> : undefined,
                });
            },
        },
        { method: "POST", path: "/hades/v1/resources", handler: (c) => runtime.apply(c.body as never) },
        {
            method: "DELETE", path: "/hades/v1/resources/:kind/:name", handler: async (c) => {
                const ns = c.url.searchParams.get("namespace") ?? "default";
                const existed = await runtime.remove(c.params.kind as never, ns, c.params.name);
                if (!existed) throw new ClientError(`${c.params.kind} ${ns}/${c.params.name} not found`, 404);
                return { ok: true, removed: c.params.name };
            },
        },
        {
            method: "GET", path: "/hades/v1/agents/:name/logs", handler: async (c) => {
                if (!runtime.kubeClient) throw new ClientError("no live cluster attached (HADES_KUBE=1 required)", 503);
                const ns = c.url.searchParams.get("namespace") ?? c.params.name;
                const tail = c.url.searchParams.get("tail");
                const text = await runtime.kubeClient.logs(ns, `brain-${c.params.name}`, "brain", tail ? { tail: Number(tail) } : {});
                return { text };
            },
        },
        { method: "POST", path: "/hades/v1/syscalls/schedules", handler: (c) => runtime.createSchedule(c.body.subject as never, c.body.spec as never) },
        { method: "POST", path: "/hades/v1/syscalls/spawn-agent", handler: (c) => runtime.spawnAgent(c.body.subject as never, c.body.spec as never) },
        { method: "POST", path: "/hades/v1/syscalls/create-agent", handler: (c) => s.createAgent(c.body.subject as never, c.body.spec as never) },
        { method: "POST", path: "/hades/v1/syscalls/create-home", handler: (c) => s.createHome(c.body.subject as never, c.body.spec as never) },
        { method: "POST", path: "/hades/v1/syscalls/attach-listener", handler: (c) => s.attachListener(c.body.subject as never, c.body.spec as never) },
        { method: "POST", path: "/hades/v1/syscalls/attach-connector", handler: (c) => runtime.connectors.attach(c.body.subject as never, c.body.spec as never) },
        { method: "POST", path: "/hades/v1/syscalls/install-packages", handler: (c) => s.installPackages(c.body.subject as never, c.body.spec as never) },
        { method: "POST", path: "/hades/v1/syscalls/publish-skill", handler: (c) => s.publishSkill(c.body.subject as never, c.body.spec as never) },
        { method: "GET", path: "/hades/v1/skills", handler: (c) => {
            const ns = c.url.searchParams.get("namespace") ?? undefined;
            const agent = c.url.searchParams.get("agent");
            const all = ns ? runtime.state.list("Skill", ns) : runtime.state.list("Skill");
            return agent ? all.filter((sk) => sk.spec?.agentRef === agent) : all;
        } },
        // The installable skill catalog (kernel discovery data, like a device-driver table).
        { method: "GET", path: "/hades/v1/skills/catalog", handler: () => ({ skills: runtime.skills.list() }) },
        // Install a catalog skill onto an agent (governance + discovery → live resources).
        { method: "POST", path: "/hades/v1/syscalls/install-skill", handler: async (c) => {
            const b = c.body;
            return runtime.installSkill(b.subject as never, String(b.skill), { agentRef: typeof b.agentRef === "string" ? b.agentRef : undefined, namespace: typeof b.namespace === "string" ? b.namespace : undefined });
        } },
        { method: "GET", path: "/hades/v1/connectors", handler: (c) => {
            const ns = c.url.searchParams.get("namespace") ?? undefined;
            const agent = c.url.searchParams.get("agent");
            const all = ns ? runtime.state.list("Connector", ns) : runtime.state.list("Connector");
            return agent ? all.filter((cn) => cn.spec?.agentRef === agent) : all;
        } },
        { method: "POST", path: "/hades/v1/syscalls/request-approval", handler: (c) => s.requestApproval(c.body.subject as never, c.body.spec as never) },
        {
            method: "POST", path: "/hades/v1/syscalls/respond-approval", handler: (c) => {
                const b = c.body;
                return s.respondApproval(b.subject as never, String(b.name), String(b.decision) as "approve" | "deny", typeof b.note === "string" ? b.note : undefined);
            },
        },
        {
            method: "POST", path: "/hades/v1/approvals/:name/respond", handler: async (c) => {
                const decision = c.url.searchParams.get("decision") === "deny" ? "deny" : "approve";
                const ns = c.url.searchParams.get("namespace") ?? "default";
                const note = typeof c.body.note === "string" ? c.body.note : undefined;
                return s.respondApprovalAsOperator(ns, c.params.name, decision, note);
            },
        },
        { method: "POST", path: "/hades/v1/syscalls/emit-artifact", handler: (c) => s.emitArtifact(c.body.subject as never, c.body.spec as never) },
        {
            method: "GET", path: "/hades/v1/syscalls/permitted", handler: (c) => {
                const name = c.url.searchParams.get("name");
                if (!name) throw new ClientError("name query param required", 400);
                const ns = c.url.searchParams.get("namespace") ?? undefined;
                return s.permittedSyscalls({ kind: "Agent", name, namespace: ns ?? name });
            },
        },
    ];
}

/** A thrown error carrying an HTTP status (default 500). */
export class ClientError extends Error {
    constructor(message: string, readonly status = 500) {
        super(message);
        this.name = "ClientError";
    }
}

export function createServer(runtime: Runtime, uiDir?: string): http.Server {
    const table = routes(runtime);
    const staticHandler = uiDir ? createStaticHandler(uiDir) : undefined;
    return http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url ?? "/", "http://localhost");
            const matched = match(req.method ?? "GET", url.pathname, table);
            // API route hit first. On a miss, try the static UI (SPA) before 404.
            if (!matched) {
                if (staticHandler && await staticHandler(req, res)) return;
                const body = await readBody(req);
                void body;
                return json(res, { error: "not found" }, 404);
            }
            const body = await readBody(req);
            const result = await matched.route.handler({ url, body, params: matched.params, res, req });
            if (result === STREAMING) return; // handler wrote the response itself
            // A handler may return { __status, body } to set a non-200 status.
            if (result && typeof result === "object" && "__status" in result) {
                const r = result as { __status: number; body: unknown };
                return json(res, r.body, r.__status);
            }
            return json(res, result);
        } catch (error) {
            if (error instanceof ClientError) return json(res, { error: error.message }, error.status);
            const message = error instanceof Error ? error.message : String(error);
            const decision = typeof error === "object" && error && "decision" in error ? (error as { decision?: PolicyDecision }).decision : undefined;
            return json(res, { error: message, decision }, decision ? 403 : 500);
        }
    });
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        let raw = "";
        req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
        req.on("error", reject);
        req.on("end", () => {
            if (!raw.trim()) return resolve({});
            try { resolve(JSON.parse(raw) as Record<string, unknown>); } catch (error) { reject(error); }
        });
    });
}

function json(res: ServerResponse, value: unknown, status = 200): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value, null, 4));
}

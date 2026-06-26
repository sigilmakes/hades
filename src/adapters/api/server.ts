import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { parsePrimitiveDecision } from "../../domain/primitives.js";
import type { Runtime } from "../../runtime/Runtime.js";
import type { PolicyDecision } from "../../domain/capabilities.js";
import { createStaticHandler } from "./static.js";

/** A request handler: given the parsed body + URL, return a JSON-serializable result (or throw). */
type Handler = (ctx: RequestContext) => Promise<unknown> | unknown;

type RequestContext = {
    url: URL;
    body: Record<string, unknown>;
    /** Path params extracted by the matcher (e.g. /agents/:name/message -> { name }). */
    params: Record<string, string>;
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
        { method: "GET", path: "/hades/v1/agents", handler: () => runtime.state.list("Agent") },
        { method: "GET", path: "/hades/v1/events", handler: (c) => runtime.events.list(c.url.searchParams.get("session") ?? undefined) },
        { method: "GET", path: "/hades/v1/state", handler: () => runtime.snapshot() },
        { method: "GET", path: "/hades/v1/projections/agents", handler: (c) => p.agentTree(c.url.searchParams.get("namespace") ?? undefined) },
        { method: "GET", path: "/hades/v1/projections/activity", handler: (c) => p.activityTail(c.url.searchParams.get("session") ?? undefined, Number(c.url.searchParams.get("limit") ?? 50)) },
        { method: "GET", path: "/hades/v1/projections/approvals", handler: (c) => p.approvalQueue(c.url.searchParams.get("namespace") ?? undefined) },
        { method: "GET", path: "/hades/v1/projections/schedules", handler: (c) => p.scheduleStatus(c.url.searchParams.get("namespace") ?? undefined) },
        { method: "GET", path: "/hades/v1/projections/listeners", handler: (c) => p.listenerStatus(c.url.searchParams.get("namespace") ?? undefined) },
        { method: "GET", path: "/hades/v1/projections/snapshot", handler: (c) => p.snapshot(c.url.searchParams.get("namespace") ?? undefined) },
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
        { method: "POST", path: "/hades/v1/syscalls/schedules", handler: (c) => runtime.createSchedule(c.body.subject as never, c.body.spec as never) },
        { method: "POST", path: "/hades/v1/syscalls/spawn-agent", handler: (c) => runtime.spawnAgent(c.body.subject as never, c.body.spec as never) },
        { method: "POST", path: "/hades/v1/syscalls/create-agent", handler: (c) => s.createAgent(c.body.subject as never, c.body.spec as never) },
        { method: "POST", path: "/hades/v1/syscalls/create-home", handler: (c) => s.createHome(c.body.subject as never, c.body.spec as never) },
        { method: "POST", path: "/hades/v1/syscalls/attach-listener", handler: (c) => s.attachListener(c.body.subject as never, c.body.spec as never) },
        { method: "POST", path: "/hades/v1/syscalls/request-approval", handler: (c) => s.requestApproval(c.body.subject as never, c.body.spec as never) },
        {
            method: "POST", path: "/hades/v1/syscalls/respond-approval", handler: (c) => {
                const b = c.body;
                return s.respondApproval(b.subject as never, String(b.name), String(b.decision) as "approve" | "deny", typeof b.note === "string" ? b.note : undefined);
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
            const result = await matched.route.handler({ url, body, params: matched.params });
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

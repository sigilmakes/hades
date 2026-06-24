import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { LocalRuntime } from "../../runtime/LocalRuntime.js";

export function createServer(runtime: LocalRuntime): http.Server {
    return http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url ?? "/", "http://localhost");
            const body = await readBody(req);
            if (req.method === "GET" && url.pathname === "/healthz") return json(res, { ok: true });
            if (req.method === "GET" && url.pathname === "/hades/v1/agents") return json(res, runtime.state.list("Agent"));
            if (req.method === "GET" && url.pathname === "/hades/v1/events") return json(res, await runtime.events.list(url.searchParams.get("session") ?? undefined));
            if (req.method === "GET" && url.pathname === "/hades/v1/state") return json(res, await runtime.snapshot());
            if (req.method === "GET" && url.pathname === "/hades/v1/primitives") {
                const decision = url.searchParams.get("decision") ?? undefined;
                return json(res, runtime.primitives.list(decision as any));
            }
            if (req.method === "POST" && url.pathname === "/hades/v1/reconcile") {
                await runtime.reconcile();
                return json(res, { ok: true });
            }
            const messageMatch = url.pathname.match(/^\/hades\/v1\/agents\/([^/]+)\/message$/);
            if (req.method === "POST" && messageMatch) {
                const result = await runtime.messageAgent(messageMatch[1], String(body.text ?? ""), {
                    namespace: typeof body.namespace === "string" ? body.namespace : undefined,
                    origin: typeof body.origin === "object" && body.origin ? body.origin as Record<string, any> : undefined,
                });
                return json(res, result);
            }
            if (req.method === "POST" && url.pathname === "/hades/v1/resources") return json(res, await runtime.apply(body as any));
            if (req.method === "POST" && url.pathname === "/hades/v1/syscalls/schedules") {
                return json(res, await runtime.createSchedule(body.subject, body.spec));
            }
            return json(res, { error: "not found" }, 404);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const decision = typeof error === "object" && error && "decision" in error ? (error as any).decision : undefined;
            return json(res, { error: message, decision }, decision ? 403 : 500);
        }
    });
}

function readBody(req: IncomingMessage): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("error", reject);
        req.on("end", () => {
            if (!raw.trim()) return resolve({});
            try { resolve(JSON.parse(raw)); } catch (error) { reject(error); }
        });
    });
}

function json(res: ServerResponse, value: unknown, status = 200): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value, null, 4));
}

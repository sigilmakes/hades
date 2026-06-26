import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { parsePrimitiveDecision } from "../../domain/primitives.js";
import type { Runtime } from "../../runtime/Runtime.js";

export function createServer(runtime: Runtime): http.Server {
    return http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url ?? "/", "http://localhost");
            const body = await readBody(req);
            if (req.method === "GET" && url.pathname === "/healthz") return json(res, { ok: true });
            if (req.method === "GET" && url.pathname === "/readyz") return json(res, runtime.ready ? { ok: true } : { ok: false, reason: "not initialized" }, runtime.ready ? 200 : 503);
            if (req.method === "GET" && url.pathname === "/hades/v1/agents") return json(res, runtime.state.list("Agent"));
            if (req.method === "GET" && url.pathname === "/hades/v1/events") return json(res, await runtime.events.list(url.searchParams.get("session") ?? undefined));
            if (req.method === "GET" && url.pathname === "/hades/v1/state") return json(res, await runtime.snapshot());
            if (req.method === "GET" && url.pathname === "/hades/v1/projections/agents") return json(res, runtime.projections.agentTree(url.searchParams.get("namespace") ?? undefined));
            if (req.method === "GET" && url.pathname === "/hades/v1/projections/activity") return json(res, await runtime.projections.activityTail(url.searchParams.get("session") ?? undefined, Number(url.searchParams.get("limit") ?? 50)));
            if (req.method === "GET" && url.pathname === "/hades/v1/projections/approvals") return json(res, runtime.projections.approvalQueue(url.searchParams.get("namespace") ?? undefined));
            if (req.method === "GET" && url.pathname === "/hades/v1/projections/schedules") return json(res, runtime.projections.scheduleStatus(url.searchParams.get("namespace") ?? undefined));
            if (req.method === "GET" && url.pathname === "/hades/v1/projections/listeners") return json(res, runtime.projections.listenerStatus(url.searchParams.get("namespace") ?? undefined));
            if (req.method === "GET" && url.pathname === "/hades/v1/projections/snapshot") return json(res, await runtime.projections.snapshot(url.searchParams.get("namespace") ?? undefined));
            if (req.method === "GET" && url.pathname === "/hades/v1/primitives") {
                const rawDecision = url.searchParams.get("decision") ?? undefined;
                try {
                    return json(res, runtime.primitives.list(parsePrimitiveDecision(rawDecision)));
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return json(res, { error: message }, 400);
                }
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
            if (req.method === "POST" && url.pathname === "/hades/v1/syscalls/spawn-agent") {
                return json(res, await runtime.spawnAgent(body.subject, body.spec));
            }
            if (req.method === "POST" && url.pathname === "/hades/v1/syscalls/create-agent") {
                return json(res, await runtime.syscalls.createAgent(body.subject, body.spec));
            }
            if (req.method === "POST" && url.pathname === "/hades/v1/syscalls/create-home") {
                return json(res, await runtime.syscalls.createHome(body.subject, body.spec));
            }
            if (req.method === "POST" && url.pathname === "/hades/v1/syscalls/attach-listener") {
                return json(res, await runtime.syscalls.attachListener(body.subject, body.spec));
            }
            if (req.method === "POST" && url.pathname === "/hades/v1/syscalls/request-approval") {
                return json(res, await runtime.syscalls.requestApproval(body.subject, body.spec));
            }
            if (req.method === "POST" && url.pathname === "/hades/v1/syscalls/respond-approval") {
                return json(res, await runtime.syscalls.respondApproval(body.subject, body.name, body.decision, body.note));
            }
            if (req.method === "POST" && url.pathname === "/hades/v1/syscalls/emit-artifact") {
                return json(res, await runtime.syscalls.emitArtifact(body.subject, body.spec));
            }
            if (req.method === "GET" && url.pathname === "/hades/v1/syscalls/permitted") {
                const subject = url.searchParams.get("subject");
                const ns = url.searchParams.get("namespace") ?? undefined;
                const name = url.searchParams.get("name") ?? undefined;
                if (!name) return json(res, { error: "name query param required" }, 400);
                return json(res, runtime.syscalls.permittedSyscalls({ kind: "Agent", name, namespace: ns ?? name }));
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

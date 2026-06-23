import http from "node:http";

export function createServer(runtime) {
    return http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://localhost");
            const body = await readBody(req);
            if (req.method === "GET" && url.pathname === "/healthz") return json(res, { ok: true });
            if (req.method === "GET" && url.pathname === "/hades/v1/agents") return json(res, runtime.state.list("Agent"));
            if (req.method === "GET" && url.pathname === "/hades/v1/events") return json(res, await runtime.events.list(url.searchParams.get("session") ?? undefined));
            if (req.method === "GET" && url.pathname === "/hades/v1/state") return json(res, await runtime.snapshot());
            if (req.method === "POST" && url.pathname === "/hades/v1/reconcile") {
                await runtime.reconcile();
                return json(res, { ok: true });
            }
            const messageMatch = url.pathname.match(/^\/hades\/v1\/agents\/([^/]+)\/message$/);
            if (req.method === "POST" && messageMatch) {
                const result = await runtime.messageAgent(messageMatch[1], body.text, { namespace: body.namespace, origin: body.origin });
                return json(res, result);
            }
            if (req.method === "POST" && url.pathname === "/hades/v1/resources") return json(res, await runtime.apply(body));
            if (req.method === "POST" && url.pathname === "/hades/v1/syscalls/schedules") {
                return json(res, await runtime.createSchedule(body.subject, body.spec));
            }
            json(res, { error: "not found" }, 404);
        } catch (error) {
            json(res, { error: error.message, decision: error.decision }, error.decision ? 403 : 500);
        }
    });
}

function readBody(req) {
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

function json(res, value, status = 200) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value, null, 4));
}

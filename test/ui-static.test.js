import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime } from "../dist/runtime/HadesRuntime.js";
import { createServer } from "../dist/adapters/api/server.js";

async function fixture() {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-static-"));
    const runtime = await (await createRuntime(dir)).init();
    // A minimal built-UI fixture: index.html + an asset.
    const uiDir = path.join(dir, "ui-dist");
    await mkdir(path.join(uiDir, "assets"), { recursive: true });
    await writeFile(path.join(uiDir, "index.html"), "<!doctype html><title>Hades</title>");
    await writeFile(path.join(uiDir, "assets", "app.js"), "console.log('hi')");
    const server = createServer(runtime, uiDir);
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    return { port, server };
}

test("GET / serves the built index.html", async () => {
    const { port, server } = await fixture();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type") ?? "", /text\/html/);
        assert.match(await res.text(), /<title>Hades<\/title>/);
    } finally {
        server.close();
    }
});

test("GET /assets/app.js serves the asset with the right mime", async () => {
    const { port, server } = await fixture();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/assets/app.js`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type") ?? "", /text\/javascript/);
        assert.equal(await res.text(), "console.log('hi')");
    } finally {
        server.close();
    }
});

test("an unknown path falls back to index.html (SPA client routing)", async () => {
    const { port, server } = await fixture();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/agents/atlas`);
        assert.equal(res.status, 200);
        assert.match(await res.text(), /<title>Hades<\/title>/);
    } finally {
        server.close();
    }
});

test("API routes still work when the UI is mounted", async () => {
    const { port, server } = await fixture();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        assert.equal(res.status, 200);
        assert.equal((await res.json()).ok, true);
    } finally {
        server.close();
    }
});

test("without a UI dir, unknown paths 404 (API-only mode)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-static-"));
    const runtime = await (await createRuntime(dir)).init();
    const server = createServer(runtime); // no uiDir
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/some/spa/path`);
        assert.equal(res.status, 404);
    } finally {
        server.close();
    }
});

test("DELETE /hades/v1/resources/:kind/:name removes a resource", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-static-"));
    const runtime = await (await createRuntime(dir)).init();
    await runtime.apply({ kind: "Agent", metadata: { name: "deletable", namespace: "ns" }, spec: { desiredState: "active", brain: { mode: "test" } } });
    const server = createServer(runtime);
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/hades/v1/resources/Agent/deletable?namespace=ns`, { method: "DELETE" });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).removed, "deletable");
        assert.equal(runtime.state.get("Agent", "ns", "deletable"), undefined);
    } finally {
        server.close();
    }
});

test("DELETE a missing resource returns 404", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-static-"));
    const runtime = await (await createRuntime(dir)).init();
    const server = createServer(runtime);
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/hades/v1/resources/Agent/ghost?namespace=ns`, { method: "DELETE" });
        assert.equal(res.status, 404);
    } finally {
        server.close();
    }
});

test("GET /agents/:name/logs returns 503 without a live cluster", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-static-"));
    const runtime = await (await createRuntime(dir)).init();
    const server = createServer(runtime); // no kubeClient
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/hades/v1/agents/atlas/logs?namespace=ns`);
        assert.equal(res.status, 503);
    } finally {
        server.close();
    }
});

test("GET /hades/v1/events/stream sends history then live events (SSE)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-static-"));
    const runtime = await (await createRuntime(dir)).init();
    // Seed history.
    await runtime.apply({ kind: "Agent", metadata: { name: "hist", namespace: "ns" }, spec: { desiredState: "active", brain: { mode: "test" } } });
    const server = createServer(runtime);
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/hades/v1/events/stream`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        // Read the replayed history (one event).
        let buf = "";
        let seenHistory = false;
        for (let i = 0; i < 20 && !seenHistory; i++) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            if (buf.includes("hist")) seenHistory = true;
        }
        assert.ok(seenHistory, "stream replayed history containing 'hist'");
        // Append a live event; the stream should deliver it.
        await runtime.apply({ kind: "Agent", metadata: { name: "live", namespace: "ns" }, spec: { desiredState: "active", brain: { mode: "test" } } });
        buf = "";
        let seenLive = false;
        for (let i = 0; i < 30 && !seenLive; i++) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            if (buf.includes("live")) seenLive = true;
        }
        assert.ok(seenLive, "stream delivered the live event containing 'live'");
        await reader.cancel();
    } finally {
        server.close();
    }
});

test("POST /approvals/:name/respond approves an approval as operator", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-static-"));
    const runtime = await (await createRuntime(dir)).init();
    await runtime.apply({ kind: "Approval", metadata: { name: "apr1", namespace: "ns" }, spec: { requestedBy: "demo", action: "spawnAgent" }, status: { phase: "requested", createdAt: new Date().toISOString() } });
    const server = createServer(runtime);
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/hades/v1/approvals/apr1/respond?decision=approve&namespace=ns`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note: "ok" }),
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.status.phase, "approved");
        assert.equal(body.status.decidedBy, "operator");
        // It left the pending queue.
        assert.equal(runtime.projections.approvalQueue("ns").length, 0);
    } finally {
        server.close();
    }
});

test("POST /approvals/:name/respond denies, and a second respond is rejected", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-static-"));
    const runtime = await (await createRuntime(dir)).init();
    await runtime.apply({ kind: "Approval", metadata: { name: "apr2", namespace: "ns" }, spec: { requestedBy: "demo", action: "spawnAgent" }, status: { phase: "requested", createdAt: new Date().toISOString() } });
    const server = createServer(runtime);
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    try {
        const deny = await fetch(`http://127.0.0.1:${port}/hades/v1/approvals/apr2/respond?decision=deny&namespace=ns`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        assert.equal((await deny.json()).status.phase, "denied");
        const again = await fetch(`http://127.0.0.1:${port}/hades/v1/approvals/apr2/respond?decision=approve&namespace=ns`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        assert.equal(again.status, 500); // already decided
    } finally {
        server.close();
    }
});

test("GET /hades/v1/templates lists available templates", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-static-"));
    const runtime = await (await createRuntime(dir)).init();
    const server = createServer(runtime);
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/hades/v1/templates`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.ok(body.templates.includes("discord-bot"));
        assert.ok(body.templates.includes("cron-worker"));
    } finally {
        server.close();
    }
});

test("POST /hades/v1/templates/:tpl/apply renders and applies a template", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-static-"));
    const runtime = await (await createRuntime(dir)).init();
    const server = createServer(runtime);
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/hades/v1/templates/cron-worker/apply`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "nightly", namespace: "agent-nightly", vars: { prompt: "Summarize the day" } }),
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.ok(body.applied >= 3);
        assert.ok(runtime.state.findByName("Agent", "nightly", "agent-nightly"));
        assert.ok(runtime.state.findByName("Schedule", "nightly-tick", "agent-nightly"));
    } finally {
        server.close();
    }
});

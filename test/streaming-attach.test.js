import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime } from "../dist/runtime/HadesRuntime.js";
import { createServer } from "../dist/adapters/api/server.js";

const NS = "stream-test";

async function fixture() {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-stream-"));
    const runtime = await (await createRuntime(dir)).init();
    await runtime.apply({ kind: "Home", metadata: { namespace: NS, name: "h" }, spec: {} });
    await runtime.apply({ kind: "Agent", metadata: { namespace: NS, name: "atlas" }, spec: { homeRef: "h", defaultSession: "atlas-default", desiredState: "active", brain: { mode: "test" } } });
    await runtime.reconcile();
    const server = createServer(runtime);
    await new Promise((r) => server.listen(0, r));
    return { runtime, server, port: server.address().port };
}

/** Consume an SSE stream and return all parsed events. */
async function consumeSse(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events = [];
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
            const data = chunk.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
            if (data) events.push(JSON.parse(data));
        }
    }
    return events;
}

test("POST /agents/:name/stream returns SSE with token + done events (#54)", async () => {
    const { server, port } = await fixture();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/hades/v1/agents/atlas/stream`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ namespace: NS, text: "hello" }),
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("content-type"), "text/event-stream");
        const events = await consumeSse(res);
        // The test brain emits the full reply as one token + a done event.
        const tokens = events.filter((e) => e.type === "token");
        const done = events.find((e) => e.type === "done");
        assert.ok(tokens.length >= 1, "at least one token event");
        assert.ok(done, "done event");
        assert.match(done.reply, /atlas received: hello/);
    } finally {
        await new Promise((r) => server.close(r));
    }
});

test("POST /agents/:name/stream emits error event on failure (#54)", async () => {
    const { server, port } = await fixture();
    try {
        // Message a non-existent agent to trigger an error.
        const res = await fetch(`http://127.0.0.1:${port}/hades/v1/agents/ghost/stream`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ namespace: NS, text: "hello" }),
        });
        const events = await consumeSse(res);
        const error = events.find((e) => e.type === "error");
        assert.ok(error, "error event emitted");
        assert.ok(error.message, "error has a message");
    } finally {
        await new Promise((r) => server.close(r));
    }
});

test("GET /agents/:name/attach returns 426 without WebSocket upgrade (#54)", async () => {
    const { server, port } = await fixture();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/hades/v1/agents/atlas/attach`);
        assert.equal(res.status, 426);
    } finally {
        await new Promise((r) => server.close(r));
    }
});

test("WebSocket attach: send message, receive token + done (#54)", async () => {
    const { server, port } = await fixture();
    const { WebSocket } = await import("ws");
    try {
        await new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}/hades/v1/agents/atlas/attach?namespace=${NS}`);
            const received = [];
            ws.on("open", () => {
                ws.send(JSON.stringify({ type: "message", text: "hello from ws" }));
            });
            ws.on("message", (data) => {
                const msg = JSON.parse(String(data));
                received.push(msg);
                if (msg.type === "done") {
                    try {
                        assert.ok(received.some((m) => m.type === "attached"), "attached event");
                        assert.ok(received.some((m) => m.type === "token"), "token event");
                        assert.match(msg.reply, /atlas received: hello from ws/);
                        ws.close();
                        resolve();
                    } catch (e) { reject(e); }
                }
            });
            ws.on("error", reject);
            setTimeout(() => { reject(new Error("timeout")); }, 5000);
        });
    } finally {
        await new Promise((r) => server.close(r));
    }
});

test("WebSocket attach: multiple messages in one session (#54)", async () => {
    const { server, port } = await fixture();
    const { WebSocket } = await import("ws");
    try {
        await new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}/hades/v1/agents/atlas/attach?namespace=${NS}`);
            let doneCount = 0;
            ws.on("open", () => {
                ws.send(JSON.stringify({ type: "message", text: "first" }));
            });
            ws.on("message", (data) => {
                const msg = JSON.parse(String(data));
                if (msg.type === "done") {
                    doneCount++;
                    if (doneCount === 1) {
                        assert.match(msg.reply, /first/);
                        ws.send(JSON.stringify({ type: "message", text: "second" }));
                    } else if (doneCount === 2) {
                        assert.match(msg.reply, /second/);
                        ws.close();
                        resolve();
                    }
                }
            });
            ws.on("error", reject);
            setTimeout(() => { reject(new Error("timeout")); }, 5000);
        });
    } finally {
        await new Promise((r) => server.close(r));
    }
});

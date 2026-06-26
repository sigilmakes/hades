import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BrainPod } from "../dist/brain-pod/server.js";
import { HttpBrainDriver, consumeSseReply } from "../dist/adapters/brain/HttpBrainDriver.js";
import { HttpHandsClient } from "../dist/adapters/hands/HttpHandsClient.js";
import { LocalConfinedHands } from "../dist/adapters/hands/LocalConfinedHands.js";

const NS = "brain-test";
const AGENT = "corvus";
const SESSION = "corvus-default";

/** A tiny mock hands server that proxies to a LocalConfinedHands over HTTP. */
async function mockHandsServer(homeRoot) {
    const hands = new LocalConfinedHands({ homeRoot });
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const body = await readJson(req);
        try {
            if (req.method === "GET" && url.pathname === "/healthz") return json(res, { ok: true });
            if (req.method === "POST" && url.pathname === "/read") return json(res, { content: await hands.read(String(body.path)) });
            if (req.method === "POST" && url.pathname === "/write") {
                const r = await hands.write(String(body.path), String(body.content));
                return json(res, r);
            }
            if (req.method === "POST" && url.pathname === "/exec") {
                const r = await hands.exec({ command: String(body.command), cwd: body.cwd });
                return json(res, r);
            }
            return json(res, { error: "not found" }, 404);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return json(res, { error: message }, 500);
        }
    });
    await new Promise((resolve) => server.listen(0, resolve));
    return { server, port: server.address().port };
}

function json(res, value, status = 200) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let raw = "";
        req.on("data", (c) => { raw += c; });
        req.on("error", reject);
        req.on("end", () => { resolve(raw.trim() ? JSON.parse(raw) : {}); });
    });
}

const agent = { kind: "Agent", metadata: { namespace: NS, name: AGENT }, spec: { displayName: "Corvus" } };
const session = { kind: "Session", metadata: { namespace: NS, name: SESSION }, spec: {} };

test("brain pod boots and reports health", async () => {
    const pod = new BrainPod({ mode: "test" });
    await new Promise((resolve) => pod.listen(0, resolve));
    const port = pod.server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.mode, "brain-pod");
    } finally {
        await pod.close();
    }
});

test("brain pod POST /run returns SSE with a done event and the reply", async () => {
    const pod = new BrainPod({ mode: "test" });
    await new Promise((resolve) => pod.listen(0, resolve));
    const port = pod.server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/run`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "text/event-stream" },
            body: JSON.stringify({ agent, session, prompt: "hello" }),
        });
        assert.ok(res.ok);
        assert.ok(res.body);
        const reply = await consumeSseReply(res.body);
        assert.match(reply, /Corvus received: hello/);
    } finally {
        await pod.close();
    }
});

test("HttpBrainDriver round-trips through a brain pod", async () => {
    const pod = new BrainPod({ mode: "test" });
    await new Promise((resolve) => pod.listen(0, resolve));
    const port = pod.server.address().port;
    try {
        const driver = new HttpBrainDriver(`http://127.0.0.1:${port}`);
        const reply = await driver.run({ agent, session, prompt: "ping" });
        assert.match(reply, /Corvus received: ping/);
    } finally {
        await pod.close();
    }
});

test("brain pod routes hades_* tool calls over HTTP to the hands endpoint", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "hades-brain-home-"));
    await mkdir(path.join(home, "vault"), { recursive: true });
    const { server: handsServer, port: handsPort } = await mockHandsServer(home);
    // Point the brain pod's hands client at the mock hands server.
    const hands = new HttpHandsClient(`http://127.0.0.1:${handsPort}`);
    const pod = new BrainPod({ mode: "test", hands });
    await new Promise((resolve) => pod.listen(0, resolve));
    const port = pod.server.address().port;
    try {
        const driver = new HttpBrainDriver(`http://127.0.0.1:${port}`);
        // write through the brain pod -> hands pod
        const writeReply = await driver.run({ agent, session, prompt: "!write vault/note.md <<<hello from brain pod" });
        assert.match(writeReply, /wrote vault\/note.md/);
        assert.equal(await readFile(path.join(home, "vault", "note.md"), "utf8"), "hello from brain pod");
        // read back through the same path
        const readReply = await driver.run({ agent, session, prompt: "!read vault/note.md" });
        assert.equal(readReply, "hello from brain pod");
    } finally {
        await pod.close();
        await new Promise((resolve) => handsServer.close(() => resolve()));
    }
});

test("brain pod reports an error event when a tool call fails", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "hades-brain-home-"));
    const { server: handsServer, port: handsPort } = await mockHandsServer(home);
    const hands = new HttpHandsClient(`http://127.0.0.1:${handsPort}`);
    const pod = new BrainPod({ mode: "test", hands });
    await new Promise((resolve) => pod.listen(0, resolve));
    const port = pod.server.address().port;
    try {
        // Reading a path that escapes home -> hands rejects -> brain pod emits error.
        await assert.rejects(
            driverRunExpectingError(`http://127.0.0.1:${port}`, { agent, session, prompt: "!read ../etc/passwd" }),
            /brain pod error:|Path escapes home|Absolute paths/,
        );
    } finally {
        await pod.close();
        await new Promise((resolve) => handsServer.close(() => resolve()));
    }
});

test("brain pod rejects unsupported directives loudly", async () => {
    const pod = new BrainPod({ mode: "test" });
    await new Promise((resolve) => pod.listen(0, resolve));
    const port = pod.server.address().port;
    try {
        await assert.rejects(
            driverRunExpectingError(`http://127.0.0.1:${port}`, { agent, session, prompt: "!bogus thing" }),
            /Unsupported brain-pod directive/,
        );
    } finally {
        await pod.close();
    }
});

test("brain pod rejects unknown paths with 404", async () => {
    const pod = new BrainPod({ mode: "test" });
    await new Promise((resolve) => pod.listen(0, resolve));
    const port = pod.server.address().port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}/nope`);
        assert.equal(res.status, 404);
    } finally {
        await pod.close();
    }
});

// Helper: run through a brain pod but surface the SSE error event as a rejection.
async function driverRunExpectingError(baseUrl, input) {
    const res = await fetch(`${baseUrl}/run`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify(input),
    });
    if (!res.ok || !res.body) throw new Error(`brain run failed (${res.status})`);
    return consumeSseReply(res.body);
}

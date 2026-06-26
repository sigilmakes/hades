import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime } from "../dist/runtime/HadesRuntime.js";
import { createServer } from "../dist/adapters/api/server.js";

const NS = "router-test";

async function fixture() {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-router-"));
    const runtime = await (await createRuntime(dir)).init();
    await runtime.apply({ kind: "Home", metadata: { namespace: NS, name: "h" }, spec: {} });
    await runtime.apply({ kind: "Agent", metadata: { namespace: NS, name: "atlas" }, spec: { homeRef: "h", defaultSession: "atlas-default", desiredState: "active", brain: { mode: "test" } } });
    await runtime.apply({ kind: "CapabilityGrant", metadata: { namespace: NS, name: "g" }, spec: { subject: { kind: "Agent", name: "atlas" }, capabilities: ["createOwnSchedule"], constraints: { namespace: "own" } } });
    await runtime.reconcile();
    const server = createServer(runtime);
    await new Promise((r) => server.listen(0, r));
    return { runtime, server, port: server.address().port };
}

test("unknown path returns 404", async () => {
    const { server, port } = await fixture();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/nope`);
        assert.equal(res.status, 404);
    } finally { await new Promise((r) => server.close(r)); }
});

test("path params are extracted (POST /agents/:name/message)", async () => {
    const { server, port } = await fixture();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/hades/v1/agents/atlas/message`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ namespace: NS, text: "hello" }),
        });
        const body = await res.json();
        assert.equal(res.status, 200);
        assert.match(body.reply, /atlas received: hello/);
    } finally { await new Promise((r) => server.close(r)); }
});

test("method mismatch on a known path returns 404", async () => {
    const { server, port } = await fixture();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/hades/v1/agents`, { method: "POST" });
        assert.equal(res.status, 404);
    } finally { await new Promise((r) => server.close(r)); }
});

test("permitted syscalls with no name returns 400 (ClientError)", async () => {
    const { server, port } = await fixture();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/hades/v1/syscalls/permitted`);
        assert.equal(res.status, 400);
    } finally { await new Promise((r) => server.close(r)); }
});

test("projections snapshot returns 200", async () => {
    const { server, port } = await fixture();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/hades/v1/projections/snapshot?namespace=${NS}`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.ok(body.agents.some((a) => a.name === "atlas"));
    } finally { await new Promise((r) => server.close(r)); }
});

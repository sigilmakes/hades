import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime } from "../dist/runtime/HadesRuntime.js";
import { createServer } from "../dist/adapters/api/server.js";

async function fixture() {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-health-"));
    const runtime = await (await createRuntime(dir)).init();
    return { dir, runtime };
}

function listen(server) {
    return new Promise((resolve) => server.listen(0, resolve)).then(() => server.address().port);
}

test("/healthz returns ok (liveness)", async () => {
    const { runtime } = await fixture();
    const server = createServer(runtime);
    const port = await listen(server);
    try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
    } finally {
        server.close();
    }
});

test("/readyz returns 200 ok once the runtime is initialized", async () => {
    const { runtime } = await fixture();
    const server = createServer(runtime);
    const port = await listen(server);
    try {
        const res = await fetch(`http://127.0.0.1:${port}/readyz`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
    } finally {
        server.close();
    }
});

test("/readyz returns 503 before init completes", async () => {
    // Build a runtime but don't call init() — ready stays false.
    const dir = await mkdtemp(path.join(tmpdir(), "hades-health-"));
    const runtime = await createRuntime(dir);
    const server = createServer(runtime);
    const port = await listen(server);
    try {
        const res = await fetch(`http://127.0.0.1:${port}/readyz`);
        assert.equal(res.status, 503);
        const body = await res.json();
        assert.equal(body.ok, false);
    } finally {
        server.close();
    }
});

test("runtime.shutdown() flips ready to false and is idempotent", async () => {
    const { runtime } = await fixture();
    assert.equal(runtime.ready, true);
    await runtime.shutdown();
    assert.equal(runtime.ready, false);
    // Idempotent — a second shutdown does not throw.
    await runtime.shutdown();
    assert.equal(runtime.ready, false);
});

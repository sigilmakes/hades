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

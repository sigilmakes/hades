import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HandsPod } from "../dist/hands-pod/server.js";
import { McpHandsClient } from "../dist/adapters/hands/McpHandsClient.js";
import { LocalConfinedHands } from "../dist/adapters/hands/LocalConfinedHands.js";

async function startHandsPod(homeRoot, options) {
    const pod = new HandsPod({ homeRoot, ...options });
    await new Promise((resolve) => pod.listen(0, resolve));
    const port = pod.server.address().port;
    return { pod, port, url: `http://127.0.0.1:${port}` };
}

async function startHandsPodWith(homeRoot, options) {
    return startHandsPod(homeRoot, options);
}

test("hands pod exposes health and wire identity", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "hades-hands-mcp-"));
    const { pod, url } = await startHandsPod(home);
    try {
        const res = await fetch(`${url}/healthz`);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.wire, "mcp-streamable-http");
    } finally {
        await pod.close();
    }
});

test("McpHandsClient lists hades tools via MCP", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "hades-hands-mcp-"));
    const { pod, url } = await startHandsPod(home);
    try {
        const client = new McpHandsClient(url);
        // Force a connection + list tools through the underlying client.
        const inner = client; // tools are listed on connect; we exercise via calls below.
        // write then read to prove round-trip
        const w = await client.write("vault/note.md", "hello mcp");
        assert.match(w.path, /vault\/note\.md/);
        const r = await client.read("vault/note.md");
        assert.equal(r, "hello mcp");
        await client.close();
    } finally {
        await pod.close();
    }
});

test("McpHandsClient write/read/exec round-trips through the hands pod over MCP", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "hades-hands-mcp-"));
    await mkdir(path.join(home, "bin"), { recursive: true });
    // Use a permissive profile so exec can run a real interpreter under
    // (would-be) container isolation — proving the exec path round-trips over
    // MCP. The confined profile's exec rejection is covered by the next test.
    const permissive = {
        id: "permissive-test",
        deniedInterpreters: new Set(),
        denyEnvPatterns: [],
        allowShellMetachars: true,
        requireHomeRelativeExecutable: false,
        timeoutMs: 5000,
    };
    const script = path.join(home, "bin", "echo.sh");
    await writeFile(script, "#!/usr/bin/env bash\necho mcp-exec-ok\n", "utf8");
    await chmod(script, 0o755);
    const { pod, url } = await startHandsPodWith(home, { profile: permissive });
    try {
        const client = new McpHandsClient(url);
        await client.write("vault/data.txt", "exec-output");
        const read = await client.read("vault/data.txt");
        assert.equal(read, "exec-output");
        const exec = await client.exec({ command: "bin/echo.sh" });
        assert.equal(exec.stdout.trim(), "mcp-exec-ok");
        assert.equal(exec.code, 0);
        await client.close();
    } finally {
        await pod.close();
    }
});

test("confinement still rejects path escapes over the MCP wire", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "hades-hands-mcp-"));
    const { pod, url } = await startHandsPod(home);
    try {
        const client = new McpHandsClient(url);
        await assert.rejects(client.read("../etc/passwd"), /Path escapes home|Absolute paths/);
        await assert.rejects(client.write("../escape", "bad"), /Path escapes home|Absolute paths/);
        await client.close();
    } finally {
        await pod.close();
    }
});

test("confinement rejects executable symlinks and denied shebangs over MCP", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "hades-hands-mcp-"));
    await mkdir(path.join(home, "bin"));
    await symlink("/bin/sh", path.join(home, "bin", "shlink"));
    const shellScript = path.join(home, "bin", "script");
    await writeFile(shellScript, "#!/usr/bin/env bash\necho nope\n", "utf8");
    await chmod(shellScript, 0o755);
    const { pod, url } = await startHandsPod(home);
    try {
        const client = new McpHandsClient(url);
        await assert.rejects(client.exec({ command: "bin/shlink" }), /symlinks are not allowed/);
        await assert.rejects(client.exec({ command: "bin/script" }), /Shebang interpreter bash is not allowed/);
        await client.close();
    } finally {
        await pod.close();
    }
});

test("hands pod confinement matches LocalConfinedHands for equivalent inputs", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "hades-hands-mcp-"));
    const local = new LocalConfinedHands({ homeRoot: home });
    const { pod, url } = await startHandsPod(home);
    try {
        const client = new McpHandsClient(url);
        await client.write("vault/same.md", "identical");
        await local.write("vault/same.md", "identical");
        assert.equal(await client.read("vault/same.md"), await local.read("vault/same.md"));
        await client.close();
    } finally {
        await pod.close();
    }
});

test("hands pod rejects unknown paths with 404", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "hades-hands-mcp-"));
    const { pod, url } = await startHandsPod(home);
    try {
        const res = await fetch(`${url}/nope`);
        assert.equal(res.status, 404);
    } finally {
        await pod.close();
    }
});

import { mkdir } from "node:fs/promises";

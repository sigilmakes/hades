import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeKubeClient } from "../dist/adapters/kube/FakeKubeClient.js";

test("FakeKubeClient.logs returns seeded pod log text", async () => {
    const kube = new FakeKubeClient();
    kube.seedLogs("agent-atlas", "brain-atlas", "line one\nline two\n");
    const text = await kube.logs("agent-atlas", "brain-atlas", "brain");
    assert.equal(text, "line one\nline two\n");
});

test("FakeKubeClient.logs returns empty string for an unknown pod", async () => {
    const kube = new FakeKubeClient();
    const text = await kube.logs("ns", "brain-ghost", "brain");
    assert.equal(text, "");
});

test("hades logs without HADES_KUBE fails with a clear message", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "hades-logs-"));
    const result = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "logs", "atlas"], {
        cwd,
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, HADES_DATA_DIR: path.join(cwd, ".hades") },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /HADES_KUBE=1/);
});

test("hades logs without an agent name fails with a clear message", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "hades-logs-"));
    const result = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "logs"], {
        cwd,
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, HADES_DATA_DIR: path.join(cwd, ".hades") },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /logs requires an agent name/);
});

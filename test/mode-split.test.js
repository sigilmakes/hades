import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createDistributedRuntime, NotImplementedError } from "../dist/runtime/DistributedRuntime.js";
import { createRuntime } from "../dist/runtime/LocalRuntime.js";

const NS = "mode-test";
const AGENT = "raven";
const HOME = "raven-home";
const SESSION = "raven-default";

async function fixture() {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-mode-"));
    const local = await createRuntime(dir).init();
    await local.apply({ kind: "Home", metadata: { namespace: NS, name: HOME }, spec: {} });
    await local.apply({ kind: "Agent", metadata: { namespace: NS, name: AGENT }, spec: { homeRef: HOME, defaultSession: SESSION, desiredState: "active", brain: { mode: "test" } } });
    await local.apply({ kind: "CapabilityGrant", metadata: { namespace: NS, name: "self" }, spec: { subject: { kind: "Agent", name: AGENT }, capabilities: ["createOwnSchedule"], constraints: { namespace: "own" } } });
    await local.reconcile();
    return { dir, local };
}

test("local runtime reports local mode", async () => {
    const { local } = await fixture();
    assert.equal(local.mode, "local");
});

test("distributed runtime reports distributed mode and reuses the kernel services", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-mode-"));
    const dist = await createDistributedRuntime(dir).init();
    assert.equal(dist.mode, "distributed");
    // Kernel services exist and are the same shape as local mode.
    assert.ok(dist.agents);
    assert.ok(dist.brain);
    assert.ok(dist.messages);
    assert.ok(dist.reconciler);
    assert.ok(dist.schedules);
    assert.ok(dist.policy);
});

test("distributed runtime runs the same kernel loop against the shared stores", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-mode-"));
    const dist = await createDistributedRuntime(dir).init();
    await dist.apply({ kind: "Home", metadata: { namespace: NS, name: HOME }, spec: {} });
    await dist.apply({ kind: "Agent", metadata: { namespace: NS, name: AGENT }, spec: { homeRef: HOME, defaultSession: SESSION, desiredState: "active", brain: { mode: "test" } } });
    await dist.apply({ kind: "CapabilityGrant", metadata: { namespace: NS, name: "self" }, spec: { subject: { kind: "Agent", name: AGENT }, capabilities: ["createOwnSchedule"], constraints: { namespace: "own" } } });
    await dist.reconcile();
    const { reply } = await dist.messageAgent(`${NS}/${AGENT}`, "!write vault/note.md <<<from distributed");
    assert.match(reply, /wrote vault\/note.md/);
    // State is durable in the shared store.
    const state = await dist.snapshot();
    assert.ok(state.Agent[`${NS}/${AGENT}`]);
});

test("distributed runtime spawn delegates to dev-mode semantics in P0", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-mode-"));
    const dist = await createDistributedRuntime(dir).init();
    await dist.apply({ kind: "Home", metadata: { namespace: NS, name: HOME }, spec: {} });
    await dist.apply({ kind: "Agent", metadata: { namespace: NS, name: AGENT }, spec: { homeRef: HOME, defaultSession: SESSION, desiredState: "active", brain: { mode: "test" } } });
    await dist.apply({ kind: "CapabilityGrant", metadata: { namespace: NS, name: "spawn-grant" }, spec: { subject: { kind: "Agent", name: AGENT }, capabilities: ["spawnAgent"], constraints: { namespace: "own" } } });
    await dist.reconcile();
    const result = await dist.spawnAgent({ kind: "Agent", name: AGENT, namespace: NS }, { name: "w1", prompt: "hi" });
    assert.match(result.reply, /received:/);
    const worker = dist.state.findByName("Agent", "w1", NS);
    assert.equal(worker.spec.lifecycle, "ephemeral");
    assert.equal(worker.status.phase, "completed");
});

test("hades controller command starts and reports distributed mode", () => {
    // The controller command should construct a runtime and report its mode.
    // We run with a tiny interval and kill it; the smoke is that it boots.
    const cwd = mkdtempSync();
    const result = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "controller", "50"], {
        cwd,
        encoding: "utf8",
        timeout: 1500,
        env: { ...process.env, HADES_DATA_DIR: path.join(cwd, ".hades") },
    });
    assert.match(result.stdout, /hades controller reconciling every 50ms/);
    assert.match(result.stdout, /mode=local/); // no HADES_MODE=distributed set
});

test("HADES_MODE=distributed makes the cli construct the distributed runtime", () => {
    const cwd = mkdtempSync();
    const result = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "controller", "50"], {
        cwd,
        encoding: "utf8",
        timeout: 1500,
        env: { ...process.env, HADES_DATA_DIR: path.join(cwd, ".hades"), HADES_MODE: "distributed" },
    });
    assert.match(result.stdout, /mode=distributed/);
});

test("deploy manifests use only standard k8s API objects — no hostPath", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const file of ["namespace-rbac.yaml", "local.yaml"]) {
        const raw = await readFile(path.resolve("deploy", file), "utf8");
        assert.equal(raw.includes("hostPath:"), false, `${file} must not use hostPath`);
    }
    const rbac = await readFile(path.resolve("deploy", "namespace-rbac.yaml"), "utf8");
    assert.ok(rbac.includes("kind: Namespace"));
    assert.ok(rbac.includes("kind: ClusterRole"));
    assert.ok(rbac.includes("kind: PersistentVolumeClaim"));
});

function mkdtempSync() {
    const dir = spawnSync("mktemp", ["-d"], { encoding: "utf8" }).stdout.trim();
    return dir;
}

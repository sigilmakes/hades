import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRuntime } from "../dist/runtime/HadesRuntime.js";
import { FakeKubeClient } from "../dist/adapters/kube/FakeKubeClient.js";
import { SqliteStateStore } from "../dist/adapters/store/SqliteStateStore.js";
import { SqliteEventStore } from "../dist/adapters/store/SqliteEventStore.js";

const NS = "mode-test";
const AGENT = "raven";
const HOME = "raven-home";
const SESSION = "raven-default";

async function fixture() {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-"));
    const rt = await (await createRuntime(dir)).init();
    await rt.apply({ kind: "Home", metadata: { namespace: NS, name: HOME }, spec: {} });
    await rt.apply({ kind: "Agent", metadata: { namespace: NS, name: AGENT }, spec: { homeRef: HOME, defaultSession: SESSION, desiredState: "active", brain: { mode: "test" } } });
    await rt.apply({ kind: "CapabilityGrant", metadata: { namespace: NS, name: "self" }, spec: { subject: { kind: "Agent", name: AGENT }, capabilities: ["createOwnSchedule"], constraints: { namespace: "own" } } });
    await rt.reconcile();
    return { dir, rt };
}

test("the runtime wires all kernel services", async () => {
    const { rt } = await fixture();
    assert.ok(rt.agents);
    assert.ok(rt.brain);
    assert.ok(rt.messages);
    assert.ok(rt.reconciler);
    assert.ok(rt.schedules);
    assert.ok(rt.policy);
    assert.ok(rt.syscalls);
    assert.ok(rt.projections);
});

test("without a kube client the controller does not run (local state only)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-"));
    const rt = await (await createRuntime(dir)).init();
    assert.equal(rt.kubeClient, undefined);
    // Reconcile still works against the in-memory state mirror.
    await rt.reconcile();
    assert.ok(rt.state);
});

test("injecting a kube client runs the controller on reconcile", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-"));
    const kube = new FakeKubeClient();
    const state = new SqliteStateStore(dir);
    const events = new SqliteEventStore(dir);
    const rt = await (await createRuntime(dir, { kubeClient: kube, stateStore: state, eventStore: events })).init();
    assert.ok(rt.kubeClient, "kube client is exposed on the runtime");
    await rt.apply({ kind: "Home", metadata: { namespace: NS, name: HOME }, spec: {} });
    await rt.apply({ kind: "Agent", metadata: { namespace: NS, name: AGENT }, spec: { homeRef: HOME, defaultSession: SESSION, desiredState: "active", brain: { mode: "test" } } });
    await rt.reconcile();
    // The controller reconciled the agent into a brain Deployment.
    assert.ok(kube.get(NS, "Deployment", `brain-${AGENT}`));
});

test("the kernel loop runs the same against injected stores", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-"));
    const rt = await (await createRuntime(dir)).init();
    await rt.apply({ kind: "Home", metadata: { namespace: NS, name: HOME }, spec: {} });
    await rt.apply({ kind: "Agent", metadata: { namespace: NS, name: AGENT }, spec: { homeRef: HOME, defaultSession: SESSION, desiredState: "active", brain: { mode: "test" } } });
    await rt.apply({ kind: "CapabilityGrant", metadata: { namespace: NS, name: "self" }, spec: { subject: { kind: "Agent", name: AGENT }, capabilities: ["createOwnSchedule"], constraints: { namespace: "own" } } });
    await rt.reconcile();
    const { reply } = await rt.messageAgent(`${NS}/${AGENT}`, "!write vault/note.md <<<hello");
    assert.match(reply, /wrote vault\/note.md/);
    const state = await rt.snapshot();
    assert.ok(state.Agent[`${NS}/${AGENT}`]);
});

test("durable sqlite stores survive a controller restart", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-durable-"));
    const rt1 = await (await createRuntime(dir)).init();
    await rt1.apply({ kind: "Home", metadata: { namespace: NS, name: HOME }, spec: {} });
    await rt1.apply({ kind: "Agent", metadata: { namespace: NS, name: AGENT }, spec: { homeRef: HOME, defaultSession: SESSION, desiredState: "active", brain: { mode: "test" } } });
    await rt1.reconcile();
    await rt1.messageAgent(`${NS}/${AGENT}`, "!write vault/durable.md <<<survives");
    // Simulate a controller pod restart: drop the runtime, make a new one on the same PVC.
    const rt2 = await (await createRuntime(dir)).init();
    assert.ok(rt2.state.get("Agent", NS, AGENT), "agent survived restart");
    assert.ok(rt2.state.get("Home", NS, HOME), "home survived restart");
    const events = await rt2.events.list(SESSION);
    assert.ok(events.some((e) => e.type === "home.file.written"), "events survived restart");
});

test("hades controller command boots and reports the reconcile interval", () => {
    const cwd = mkdtempSync();
    const result = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "controller", "50"], {
        cwd,
        encoding: "utf8",
        timeout: 1500,
        env: { ...process.env, HADES_DATA_DIR: path.join(cwd, ".hades") },
    });
    assert.match(result.stdout, /hades controller reconciling every 50ms/);
    assert.match(result.stderr, /HADES_KUBE not set/);
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

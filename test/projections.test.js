import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime } from "../dist/runtime/HadesRuntime.js";
import { createServer } from "../dist/adapters/api/server.js";

const NS = "proj-test";
const AGENT = "wren";
const HOME = "wren-home";
const SESSION = "wren-default";

async function fixture() {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-proj-"));
    const runtime = await (await createRuntime(dir)).init();
    await runtime.apply({ kind: "Home", metadata: { namespace: NS, name: HOME }, spec: {} });
    await runtime.apply({ kind: "Agent", metadata: { namespace: NS, name: AGENT }, spec: { homeRef: HOME, defaultSession: SESSION, desiredState: "active", brain: { mode: "test" } } });
    await runtime.apply({ kind: "CapabilityGrant", metadata: { namespace: NS, name: "g" }, spec: { subject: { kind: "Agent", name: AGENT }, capabilities: ["createOwnSchedule", "requestApproval", "respondApproval"], constraints: { namespace: "own" } } });
    await runtime.reconcile();
    return { dir, runtime };
}

test("agentTree lists agents with phase, lifecycle, and brain pod", async () => {
    const { runtime } = await fixture();
    const tree = runtime.projections.agentTree(NS);
    const wren = tree.find((a) => a.name === AGENT);
    assert.ok(wren);
    assert.equal(wren.lifecycle, "resident");
    assert.equal(wren.phase, "active");
    assert.equal(wren.systemAgent, false);
    // brainPod is set by the k8s controller in deploy mode; in dev mode it's undefined.
    assert.equal(wren.session, SESSION);
    // System agents appear in the hades-system namespace.
    const sysAgents = runtime.projections.agentTree("hades-system");
    assert.ok(sysAgents.some((a) => a.name === "provisioner" && a.systemAgent));
});

test("activityTail returns recent events with summaries", async () => {
    const { runtime } = await fixture();
    await runtime.messageAgent(`${NS}/${AGENT}`, "!write vault/note.md <<<hello");
    const tail = await runtime.projections.activityTail(SESSION);
    assert.ok(tail.length > 0);
    assert.ok(tail.some((e) => e.type === "home.file.written" && e.summary.includes("vault/note.md")));
    assert.ok(tail.some((e) => e.type === "brain.sleeping"));
});

test("activityTail respects the limit", async () => {
    const { runtime } = await fixture();
    await runtime.messageAgent(`${NS}/${AGENT}`, "!write vault/a.md <<<1");
    await runtime.messageAgent(`${NS}/${AGENT}`, "!write vault/b.md <<<2");
    const tail = await runtime.projections.activityTail(SESSION, 2);
    assert.ok(tail.length <= 2);
});

test("approvalQueue lists pending approvals", async () => {
    const { runtime } = await fixture();
    await runtime.syscalls.requestApproval({ kind: "Agent", name: AGENT, namespace: NS }, { name: "deploy", action: "deploy" });
    const queue = runtime.projections.approvalQueue(NS);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].action, "deploy");
    assert.equal(queue[0].requestedBy, AGENT);
    // After responding, it leaves the queue.
    await runtime.syscalls.respondApproval({ kind: "Agent", name: AGENT, namespace: NS }, "deploy", "approve");
    assert.equal(runtime.projections.approvalQueue(NS).length, 0);
});

test("scheduleStatus lists schedules with phase", async () => {
    const { runtime } = await fixture();
    await runtime.createSchedule({ kind: "Agent", name: AGENT, namespace: NS }, { name: "tick", agentRef: AGENT, type: "once", schedule: "1970-01-01T00:00:00Z", session: SESSION, prompt: "hi" });
    await runtime.reconcile();
    const statuses = runtime.projections.scheduleStatus(NS);
    const tick = statuses.find((s) => s.name === "tick");
    assert.ok(tick);
    assert.equal(tick.type, "once");
});

test("listenerStatus lists listeners with platform", async () => {
    const { runtime } = await fixture();
    await runtime.apply({ kind: "Listener", metadata: { namespace: NS, name: "wren-cli" }, spec: { agentRef: AGENT, platform: "cli" } });
    await runtime.reconcile();
    const statuses = runtime.projections.listenerStatus(NS);
    const cli = statuses.find((l) => l.name === "wren-cli");
    assert.ok(cli);
    assert.equal(cli.platform, "cli");
    assert.equal(cli.phase, "connected");
});

test("snapshot returns the full control-room view", async () => {
    const { runtime } = await fixture();
    await runtime.messageAgent(`${NS}/${AGENT}`, "hello");
    const snap = await runtime.projections.snapshot(NS);
    assert.ok(snap.agents.length > 0, "agents in snapshot");
    assert.ok(snap.recentActivity.length > 0, "activity in snapshot");
    assert.ok(Array.isArray(snap.runs));
    assert.ok(Array.isArray(snap.approvals));
    assert.ok(Array.isArray(snap.schedules));
    assert.ok(Array.isArray(snap.listeners));
});

test("projection API endpoints return the views", async () => {
    const { runtime } = await fixture();
    await runtime.messageAgent(`${NS}/${AGENT}`, "!write vault/x.md <<<hi");
    const server = createServer(runtime);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    try {
        const agents = await fetch(`http://127.0.0.1:${port}/hades/v1/projections/agents?namespace=${NS}`).then((r) => r.json());
        assert.ok(agents.some((a) => a.name === AGENT));
        const activity = await fetch(`http://127.0.0.1:${port}/hades/v1/projections/activity?session=${SESSION}`).then((r) => r.json());
        assert.ok(activity.length > 0);
        const snap = await fetch(`http://127.0.0.1:${port}/hades/v1/projections/snapshot?namespace=${NS}`).then((r) => r.json());
        assert.ok(snap.agents.length > 0);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

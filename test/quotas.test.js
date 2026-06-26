import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime } from "../dist/runtime/HadesRuntime.js";

const NS = "quota-test";
const AGENT = "atlas";
const HOME = "atlas-home";
const SESSION = "atlas-default";

async function fixture(quota) {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-quota-"));
    const runtime = await (await createRuntime(dir)).init();
    await runtime.apply({ kind: "Home", metadata: { namespace: NS, name: HOME }, spec: {} });
    await runtime.apply({ kind: "Agent", metadata: { namespace: NS, name: AGENT }, spec: { homeRef: HOME, defaultSession: SESSION, desiredState: "active", brain: { mode: "test" } } });
    const caps = ["createAgent", "createHome", "attachListener", "createOwnSchedule", "spawnAgent"];
    await runtime.apply({ kind: "CapabilityGrant", metadata: { namespace: NS, name: "g" }, spec: { subject: { kind: "Agent", name: AGENT }, capabilities: caps, constraints: { namespace: "own" } } });
    if (quota) {
        await runtime.apply({ kind: "NamespaceQuota", metadata: { namespace: NS, name: "default" }, spec: { limits: quota } });
    }
    await runtime.reconcile();
    return { dir, runtime };
}

test("without a quota, createAgent is unlimited", async () => {
    const { runtime } = await fixture();
    // Can create several agents — no cap.
    for (let i = 0; i < 5; i++) {
        await runtime.syscalls.createAgent({ kind: "Agent", name: AGENT, namespace: NS }, { name: `a${i}`, brain: { mode: "test" } });
    }
    const agents = runtime.state.list("Agent", NS);
    assert.ok(agents.length >= 6);
});

test("a NamespaceQuota caps Agent creation at the limit", async () => {
    const { runtime } = await fixture({ Agent: 1 });
    // atlas already exists (1); a second should be denied.
    await assert.rejects(
        runtime.syscalls.createAgent({ kind: "Agent", name: AGENT, namespace: NS }, { name: "overflow", brain: { mode: "test" } }),
        /Quota exceeded: Agent in quota-test \(1\/1\)/,
    );
});

test("a quota on one kind does not affect others", async () => {
    const { runtime } = await fixture({ Agent: 2 });
    // Agent capped, but Home/Schedule are unlimited.
    await runtime.syscalls.createHome({ kind: "Agent", name: AGENT, namespace: NS }, { name: "extra-home" });
    await runtime.createSchedule({ kind: "Agent", name: AGENT, namespace: NS }, { name: "tick", type: "once", schedule: "2030-01-01T00:00:00Z", session: SESSION, prompt: "hi" });
    assert.ok(runtime.state.list("Home", NS).length >= 2);
    assert.ok(runtime.state.list("Schedule", NS).length >= 1);
});

test("spawnAgent is capped by the Agent quota", async () => {
    const { runtime } = await fixture({ Agent: 1 });
    // atlas = 1; spawning a second agent is denied.
    await assert.rejects(
        runtime.spawnAgent({ kind: "Agent", name: AGENT, namespace: NS }, { name: "ephemeral-1", prompt: "hi" }),
        /Quota exceeded: Agent in quota-test \(1\/1\)/,
    );
});

test("createOwnSchedule is capped by the Schedule quota", async () => {
    const { runtime } = await fixture({ Schedule: 1 });
    await runtime.createSchedule({ kind: "Agent", name: AGENT, namespace: NS }, { name: "first", type: "once", schedule: "2030-01-01T00:00:00Z", session: SESSION, prompt: "hi" });
    await assert.rejects(
        runtime.createSchedule({ kind: "Agent", name: AGENT, namespace: NS }, { name: "second", type: "once", schedule: "2030-01-01T00:00:00Z", session: SESSION, prompt: "hi" }),
        /Quota exceeded: Schedule in quota-test \(1\/1\)/,
    );
});

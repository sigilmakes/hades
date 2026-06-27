import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime } from "../dist/runtime/HadesRuntime.js";

const NS = "spawn-test";
const PARENT = "parent";
const HOME = "parent-home";

async function fixture() {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-spawn-"));
    const runtime = await (await createRuntime(dir)).init();
    await runtime.apply({ kind: "Home", metadata: { namespace: NS, name: HOME }, spec: {} });
    await runtime.apply({ kind: "Agent", metadata: { namespace: NS, name: PARENT }, spec: { homeRef: HOME, defaultSession: `${PARENT}-default`, desiredState: "active", brain: { mode: "test" } } });
    await runtime.apply({ kind: "CapabilityGrant", metadata: { namespace: NS, name: "spawn-grant" }, spec: { subject: { kind: "Agent", name: PARENT }, capabilities: ["spawnAgent"], constraints: { namespace: "own" } } });
    return { dir, runtime };
}

const parentSubject = { kind: "Agent", name: PARENT, namespace: NS };

test("ephemeral spawn is reaped after the prompt (default behavior)", async () => {
    const { runtime } = await fixture();
    const { agent, reply } = await runtime.spawnAgent(parentSubject, { name: "eph", prompt: "hello" });
    assert.match(reply, /eph received: hello/);
    assert.equal(agent.spec.lifecycle, "ephemeral");
    assert.equal(agent.status?.phase, "completed", "ephemeral agent is reaped (completed)");
    assert.ok(agent.status?.reapedAt, "reapedAt timestamp set");
});

test("resident spawn stays active and accepts multiple messages (#52)", async () => {
    const { runtime } = await fixture();
    const { agent, reply } = await runtime.spawnAgent(parentSubject, { name: "sub", lifecycle: "resident", prompt: "first message" });
    assert.match(reply, /sub received: first message/);
    assert.equal(agent.spec.lifecycle, "resident");
    assert.notEqual(agent.status?.phase, "completed", "resident subordinate is not reaped");
    assert.equal(agent.status?.reapedAt, undefined, "no reapedAt on a resident subordinate");

    // The subordinate is still active — send a second message.
    const { reply: reply2 } = await runtime.messageAgent(`${NS}/sub`, "second message");
    assert.match(reply2, /sub received: second message/);

    // And a third — the session persists across turns.
    const { reply: reply3 } = await runtime.messageAgent(`${NS}/sub`, "third message");
    assert.match(reply3, /sub received: third message/);

    // The subordinate's session recorded all three turns.
    const events = await runtime.events.list("sub-default");
    const messages = events.filter((e) => e.type === "agent.message");
    assert.equal(messages.length, 3, "three turns recorded in the session");
});

test("resident spawn keeps its brain pod running (not cascade-deleted)", async () => {
    const { runtime } = await fixture();
    await runtime.spawnAgent(parentSubject, { name: "persistent", lifecycle: "resident", prompt: "wake" });
    // The agent should be active, not completed — the controller won't cascade-delete.
    const agent = runtime.state.findByName("Agent", "persistent", NS);
    assert.equal(agent?.spec.lifecycle, "resident");
    assert.notEqual(agent?.status?.phase, "completed");
});

test("resident spawn event records lifecycle", async () => {
    const { runtime } = await fixture();
    await runtime.spawnAgent(parentSubject, { name: "rec", lifecycle: "resident", prompt: "x" });
    const sys = await runtime.events.list("system");
    const spawned = sys.find((e) => e.type === "agent.spawned" && e.payload.agent === "rec");
    assert.ok(spawned, "agent.spawned event recorded");
    assert.equal(spawned.payload.lifecycle, "resident", "lifecycle recorded in spawn event");
    // No reap event for resident subordinates.
    const reaped = sys.find((e) => e.type === "agent.reaped" && e.payload.agent === "rec");
    assert.equal(reaped, undefined, "no agent.reaped event for resident subordinate");
});

test("spawn with capabilities: resident keeps the grant", async () => {
    const { runtime } = await fixture();
    await runtime.spawnAgent(parentSubject, { name: "cap", lifecycle: "resident", capabilities: ["createOwnSchedule"], prompt: "x" });
    // The grant should still exist (not removed for resident subordinates).
    const grant = runtime.state.findByName("CapabilityGrant", "cap-spawn-grant", NS);
    assert.ok(grant, "capability grant persists on resident subordinate");
});

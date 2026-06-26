import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime } from "../dist/runtime/HadesRuntime.js";

async function rt() {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-life-"));
    return (await createRuntime(dir)).init();
}

test("re-applying an identical resource does not emit a duplicate resource.applied event", async () => {
    const runtime = await rt();
    const agent = { kind: "Agent", metadata: { name: "a", namespace: "ns" }, spec: { desiredState: "active", brain: { mode: "test" } } };
    await runtime.apply(agent);
    const before = (await runtime.events.list()).filter((e) => e.type === "resource.applied").length;
    await runtime.apply(agent); // identical
    await runtime.apply(agent); // identical again
    const after = (await runtime.events.list()).filter((e) => e.type === "resource.applied").length;
    assert.equal(after, before, "no new resource.applied event on identical re-apply");
});

test("applying a changed spec emits a new resource.applied event", async () => {
    const runtime = await rt();
    await runtime.apply({ kind: "Agent", metadata: { name: "a", namespace: "ns" }, spec: { desiredState: "active", brain: { mode: "test" } } });
    const before = (await runtime.events.list()).filter((e) => e.type === "resource.applied").length;
    await runtime.apply({ kind: "Agent", metadata: { name: "a", namespace: "ns" }, spec: { desiredState: "idle", brain: { mode: "test" } } });
    const after = (await runtime.events.list()).filter((e) => e.type === "resource.applied").length;
    assert.equal(after, before + 1, "a changed spec emits exactly one new event");
});

test("runtime.remove deletes a resource and emits resource.removed", async () => {
    const runtime = await rt();
    await runtime.apply({ kind: "Agent", metadata: { name: "a", namespace: "ns" }, spec: { desiredState: "active", brain: { mode: "test" } } });
    const existed = await runtime.remove("Agent", "ns", "a");
    assert.equal(existed, true);
    assert.equal(runtime.state.get("Agent", "ns", "a"), undefined);
    const removed = (await runtime.events.list()).filter((e) => e.type === "resource.removed");
    assert.equal(removed.length, 1);
    assert.equal(removed[0].payload.name, "a");
});

test("runtime.remove on a missing resource is a no-op (no event)", async () => {
    const runtime = await rt();
    const existed = await runtime.remove("Agent", "ns", "ghost");
    assert.equal(existed, false);
    const removed = (await runtime.events.list()).filter((e) => e.type === "resource.removed");
    assert.equal(removed.length, 0);
});

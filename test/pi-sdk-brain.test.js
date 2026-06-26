import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime } from "../dist/runtime/HadesRuntime.js";
import { PiSdkBrainDriver } from "../dist/adapters/brain/PiSdkBrainDriver.js";
import { JsonlEventStore } from "../dist/adapters/store/JsonlEventStore.js";
import { LocalConfinedHands } from "../dist/adapters/hands/LocalConfinedHands.js";

/**
 * Exercises the pi-SDK brain path: the model/harness loop runs through a real
 * pi AgentSession, tool calls route through Hands, and events are durable.
 *
 * This needs a working model provider in the environment (the pi SDK resolves
 * providers/keys from its config). It skips if no model resolves.
 */
async function modelResolves() {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-pi-probe-"));
    const events = new JsonlEventStore(dir);
    await events.init();
    const hands = new LocalConfinedHands({ homeRoot: dir, events, sessionId: "probe" });
    const driver = new PiSdkBrainDriver(events, () => dir, () => hands);
    try {
        const reply = await driver.run({
            agent: { kind: "Agent", metadata: { namespace: "n", name: "probe" }, spec: { brain: { mode: "pi-sdk" } } },
            session: { kind: "Session", metadata: { namespace: "n", name: "probe" }, spec: {} },
            prompt: "reply with the single word OK",
        });
        return reply.length > 0;
    } catch {
        return false;
    }
}

const hasModel = await modelResolves();

test("pi-sdk brain runs a real model and routes tools through hands", { skip: !hasModel }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-pi-"));
    await mkdir(path.join(dir, "vault"), { recursive: true });
    const runtime = await (await createRuntime(dir)).init();
    await runtime.apply({ kind: "Home", metadata: { namespace: "pi-test", name: "pi-home" }, spec: {} });
    await runtime.apply({ kind: "Agent", metadata: { namespace: "pi-test", name: "atlas" }, spec: { homeRef: "pi-home", defaultSession: "atlas-default", desiredState: "active", brain: { mode: "pi-sdk" } } });
    await runtime.apply({ kind: "CapabilityGrant", metadata: { namespace: "pi-test", name: "self" }, spec: { subject: { kind: "Agent", name: "atlas" }, capabilities: ["createOwnSchedule"], constraints: { namespace: "own" } } });
    await runtime.reconcile();

    const { reply } = await runtime.messageAgent("pi-test/atlas", "Write the word hello to vault/greeting.md");
    assert.ok(reply.length > 0, "the real model produced a reply");
    // The model's tool call routed through hands to the home.
    const events = await runtime.events.list("atlas-default");
    assert.ok(events.some((e) => e.type === "brain.model.completed"), "brain.model.completed event recorded");
});

test("the model's tool calls reach hands (hades_write) and persist", { skip: !hasModel }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-pi-tools-"));
    await mkdir(path.join(dir, "vault"), { recursive: true });
    const runtime = await (await createRuntime(dir)).init();
    await runtime.apply({ kind: "Home", metadata: { namespace: "pi-tools", name: "pi-home" }, spec: {} });
    await runtime.apply({ kind: "Agent", metadata: { namespace: "pi-tools", name: "atlas" }, spec: { homeRef: "pi-home", defaultSession: "atlas-default", desiredState: "active", brain: { mode: "pi-sdk" } } });
    await runtime.reconcile();

    await runtime.messageAgent("pi-tools/atlas", "Use hades_write to create vault/note.md with the content: pi-sdk works");
    const events = await runtime.events.list("atlas-default");
    // A write tool call should have produced a home.file.written event.
    assert.ok(events.some((e) => e.type === "home.file.written"), "the model's hades_write reached hands");
});

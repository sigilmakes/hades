import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime } from "../dist/runtime/HadesRuntime.js";
import { CliBridge, bridgeForListener } from "../dist/ports/ListenerBridge.js";

const NS = "listener-test";
const AGENT = "wren";
const HOME = "wren-home";
const SESSION = "wren-default";

async function fixture() {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-listener-"));
    const runtime = await (await createRuntime(dir)).init();
    await runtime.apply({ kind: "Home", metadata: { namespace: NS, name: HOME }, spec: {} });
    await runtime.apply({ kind: "Agent", metadata: { namespace: NS, name: AGENT }, spec: { homeRef: HOME, defaultSession: SESSION, desiredState: "active", brain: { mode: "test" } } });
    await runtime.apply({ kind: "Listener", metadata: { namespace: NS, name: "wren-cli" }, spec: { agentRef: AGENT, platform: "cli" } });
    await runtime.reconcile();
    return { dir, runtime };
}

test("cli bridge routes an inbound message to the agent and returns the reply", async () => {
    const { runtime } = await fixture();
    const bridge = new CliBridge("wren-cli", AGENT, SESSION);
    bridge.onMessage(async (message) => {
        const { reply } = await runtime.messageAgent(AGENT, message.content, { namespace: NS });
        return { reply, origin: message.origin };
    });
    await bridge.start();
    const reply = await bridge.receive("hello bird");
    assert.match(reply, /received: hello bird/);
    await bridge.stop();
});

test("cli bridge rejects messages before start", async () => {
    const bridge = new CliBridge("x", "a", "s");
    bridge.onMessage(async (m) => ({ reply: "", origin: m.origin }));
    await assert.rejects(bridge.receive("hi"), /not started/);
});

test("bridgeForListener returns a CliBridge for the cli platform", () => {
    const listener = { kind: "Listener", metadata: { namespace: NS, name: "wren-cli" }, spec: { agentRef: AGENT, platform: "cli" } };
    const bridge = bridgeForListener(listener, SESSION);
    assert.equal(bridge.platform, "cli");
    assert.equal(bridge instanceof CliBridge, true);
});

test("bridgeForListener returns an UnconfiguredBridge for unwired platforms", () => {
    const listener = { kind: "Listener", metadata: { namespace: NS, name: "wren-discord" }, spec: { agentRef: AGENT, platform: "discord" } };
    const bridge = bridgeForListener(listener, SESSION);
    assert.equal(bridge.platform, "discord");
    // start fails loudly — the resource model exists, the SDK is the missing piece.
    assert.rejects(bridge.start(), /not configured/);
});

test("cli bridge round-trips a tool call through the agent", async () => {
    const { runtime } = await fixture();
    const bridge = new CliBridge("wren-cli", AGENT, SESSION);
    bridge.onMessage(async (message) => {
        const { reply } = await runtime.messageAgent(AGENT, message.content, { namespace: NS });
        return { reply, origin: message.origin };
    });
    await bridge.start();
    const writeReply = await bridge.receive("!write vault/bridge.md <<<from bridge");
    assert.match(writeReply, /wrote vault\/bridge.md/);
    const readReply = await bridge.receive("!read vault/bridge.md");
    assert.equal(readReply, "from bridge");
    await bridge.stop();
});

test("listener resource reconciles to connected phase for cli", async () => {
    const { runtime } = await fixture();
    const listener = runtime.state.findByName("Listener", "wren-cli", NS);
    assert.equal(listener.status.phase, "connected");
});

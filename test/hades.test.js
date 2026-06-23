import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HadesRuntime } from "../src/core/controllers.js";
import { HandsExecutor, sanitizedEnv } from "../src/core/hands.js";
import { createServer } from "../src/api/server.js";

async function runtimeFixture() {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-test-"));
    const runtime = await new HadesRuntime(dir).init();
    await runtime.apply({ kind: "Home", metadata: { namespace: "agent-wren", name: "wren-home" }, spec: { layout: { create: ["vault", "bin", "cron.d"] } } });
    await runtime.apply({ kind: "Agent", metadata: { namespace: "agent-wren", name: "wren" }, spec: { displayName: "Wren", homeRef: "wren-home", defaultSession: "wren-default", desiredState: "active" } });
    await runtime.apply({ kind: "Listener", metadata: { namespace: "agent-wren", name: "wren-cli" }, spec: { agentRef: "wren", platform: "cli" } });
    await runtime.apply({ kind: "CapabilityGrant", metadata: { namespace: "agent-wren", name: "self" }, spec: { subject: { kind: "Agent", name: "wren" }, capabilities: ["createOwnSchedule"], constraints: { namespace: "own" } } });
    await runtime.reconcile();
    return { dir, runtime };
}

test("full local loop writes through hands and records durable events", async () => {
    const { runtime } = await runtimeFixture();
    const { reply } = await runtime.messageAgent("wren", "!write vault/note.md <<<hello bird");
    assert.match(reply, /wrote vault\/note.md/);
    const home = runtime.state.findByName("Home", "wren-home", "agent-wren");
    assert.equal(await readFile(path.join(home.status.path, "vault/note.md"), "utf8"), "hello bird");
    const events = await runtime.events.list("wren-default");
    assert.ok(events.some((event) => event.type === "listener.message.received"));
    assert.ok(events.some((event) => event.type === "home.file.written"));
    assert.ok(events.some((event) => event.type === "brain.sleeping"));
});

test("agent can create schedule through policy-checked syscall", async () => {
    const { runtime } = await runtimeFixture();
    const schedule = await runtime.createSchedule(
        { kind: "Agent", name: "wren", namespace: "agent-wren" },
        { name: "self-test", agentRef: "wren", type: "once", schedule: "1970-01-01T00:00:00Z", session: "wren-default", prompt: "scheduled hi" },
    );
    assert.equal(schedule.metadata.name, "self-test");
    await runtime.reconcile();
    const events = await runtime.events.list("wren-default");
    assert.ok(events.some((event) => event.type === "schedule.fired"));
});

test("capability denial is explicit", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-test-"));
    const runtime = await new HadesRuntime(dir).init();
    await assert.rejects(
        runtime.createSchedule({ kind: "Agent", name: "intruder", namespace: "agent-wren" }, { name: "bad" }),
        /Capability denied/,
    );
});

test("hands env does not expose secret-like variables", () => {
    process.env.HADES_FAKE_SECRET = "nope";
    process.env.HADES_FAKE_TOKEN = "nope";
    const env = sanitizedEnv();
    assert.equal(env.HADES_FAKE_SECRET, undefined);
    assert.equal(env.HADES_FAKE_TOKEN, undefined);
    assert.equal(env.HADES_HANDS, "1");
});

test("API exposes agents and message endpoint", async () => {
    const { runtime } = await runtimeFixture();
    const server = createServer(runtime);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    try {
        const agents = await fetch(`http://127.0.0.1:${port}/hades/v1/agents`).then((res) => res.json());
        assert.equal(agents[0].metadata.name, "wren");
        const response = await fetch(`http://127.0.0.1:${port}/hades/v1/agents/wren/message`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ namespace: "agent-wren", text: "hello" }),
        }).then((res) => res.json());
        assert.match(response.reply, /received: hello/);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("hands prevent path escape", async () => {
    const { runtime } = await runtimeFixture();
    const home = runtime.state.findByName("Home", "wren-home", "agent-wren");
    const hands = new HandsExecutor({ homeRoot: home.status.path });
    await assert.rejects(hands.write("../escape", "bad"), /Path escapes home/);
});

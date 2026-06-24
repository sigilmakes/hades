import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRuntime } from "../dist/runtime/LocalRuntime.js";
import { LocalConfinedHands, sanitizedEnv } from "../dist/adapters/hands/LocalConfinedHands.js";
import { parseConfinedExecCommand } from "../dist/adapters/hands/ConfinedCommandParser.js";
import { createServer } from "../dist/adapters/api/server.js";

const NS = "agent-test";
const AGENT = "raven";
const HOME = "raven-home";
const SESSION = "raven-default";

test("build output does not retain removed core or api modules", async () => {
    await assert.rejects(readdir(path.resolve("dist/core")), /ENOENT/);
    await assert.rejects(readdir(path.resolve("dist/api")), /ENOENT/);
});

async function runtimeFixture() {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-test-"));
    const runtime = await createRuntime(dir).init();
    await runtime.apply({ kind: "Home", metadata: { namespace: NS, name: HOME }, spec: { layout: { create: ["vault", "bin", "cron.d"] } } });
    await runtime.apply({ kind: "Agent", metadata: { namespace: NS, name: AGENT }, spec: { displayName: "Raven", homeRef: HOME, defaultSession: SESSION, desiredState: "active", brain: { mode: "test" } } });
    await runtime.apply({ kind: "Listener", metadata: { namespace: NS, name: "raven-cli" }, spec: { agentRef: AGENT, platform: "cli" } });
    await runtime.apply({ kind: "CapabilityGrant", metadata: { namespace: NS, name: "self" }, spec: { subject: { kind: "Agent", name: AGENT }, capabilities: ["createOwnSchedule"], constraints: { namespace: "own" } } });
    await runtime.reconcile();
    return { dir, runtime };
}

test("full local loop writes through hands and records durable events", async () => {
    const { runtime } = await runtimeFixture();
    const { reply } = await runtime.messageAgent(`${NS}/${AGENT}`, "!write vault/note.md <<<hello bird");
    assert.match(reply, /wrote vault\/note.md/);
    const home = runtime.state.findByName("Home", HOME, NS);
    assert.equal(await readFile(path.join(home.status.path, "vault/note.md"), "utf8"), "hello bird");
    const events = await runtime.events.list(SESSION);
    assert.ok(events.some((event) => event.type === "listener.message.received"));
    assert.ok(events.some((event) => event.type === "home.file.written"));
    assert.ok(events.some((event) => event.type === "brain.sleeping"));
});

test("pi sdk is the default brain mode", async () => {
    const { runtime } = await runtimeFixture();
    const oldMode = process.env.HADES_BRAIN_MODE;
    delete process.env.HADES_BRAIN_MODE;
    try {
        assert.equal(runtime.brain.resolveMode({ kind: "Agent", metadata: { namespace: NS, name: "default-brain" }, spec: {} }), "pi-sdk");
    } finally {
        if (oldMode === undefined) delete process.env.HADES_BRAIN_MODE;
        else process.env.HADES_BRAIN_MODE = oldMode;
    }
});

test("agent can create schedule through policy-checked syscall", async () => {
    const { runtime } = await runtimeFixture();
    const schedule = await runtime.createSchedule(
        { kind: "Agent", name: AGENT, namespace: NS },
        { name: "self-test", agentRef: AGENT, type: "once", schedule: "1970-01-01T00:00:00Z", session: SESSION, prompt: "scheduled hi" },
    );
    assert.equal(schedule.metadata.name, "self-test");
    await runtime.reconcile();
    const events = await runtime.events.list(SESSION);
    assert.ok(events.some((event) => event.type === "schedule.fired"));
});

test("createOwnSchedule requires concrete existing subject and session", async () => {
    const { runtime } = await runtimeFixture();
    await assert.rejects(
        runtime.createSchedule(
            { kind: "Agent", name: AGENT },
            { name: "missing-namespace", agentRef: AGENT, type: "once", schedule: "1970-01-01T00:00:00Z", session: SESSION, prompt: "nope" },
        ),
        /Subject namespace is required/,
    );
    await assert.rejects(
        runtime.createSchedule(
            { kind: "Agent", name: AGENT, namespace: NS },
            { name: "missing-session", agentRef: AGENT, type: "once", schedule: "1970-01-01T00:00:00Z", session: "does-not-exist", prompt: "nope" },
        ),
        /requires an existing session/,
    );
});

test("createOwnSchedule cannot target another agent", async () => {
    const { runtime } = await runtimeFixture();
    await runtime.apply({ kind: "Agent", metadata: { namespace: NS, name: "other" }, spec: { defaultSession: "other-default" } });
    await assert.rejects(
        runtime.createSchedule(
            { kind: "Agent", name: AGENT, namespace: NS },
            { name: "bad-target", agentRef: "other", type: "once", schedule: "1970-01-01T00:00:00Z", prompt: "nope" },
        ),
        /cannot target another agent/,
    );
});

test("test brain schedule directive is policy checked", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-test-"));
    const runtime = await createRuntime(dir).init();
    await runtime.apply({ kind: "Home", metadata: { namespace: NS, name: HOME }, spec: {} });
    await runtime.apply({ kind: "Agent", metadata: { namespace: NS, name: AGENT }, spec: { homeRef: HOME, defaultSession: SESSION, desiredState: "active", brain: { mode: "test" } } });
    await runtime.reconcile();
    await assert.rejects(
        runtime.messageAgent(`${NS}/${AGENT}`, "!schedule bad once 1970-01-01T00:00:00Z :: nope"),
        /Capability denied/,
    );
});

test("capability denial is explicit", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-test-"));
    const runtime = await createRuntime(dir).init();
    await runtime.apply({ kind: "Home", metadata: { namespace: NS, name: HOME }, spec: {} });
    await runtime.apply({ kind: "Agent", metadata: { namespace: NS, name: "nogrant" }, spec: { homeRef: HOME, defaultSession: "nogrant-default" } });
    await runtime.reconcile();
    await assert.rejects(
        runtime.createSchedule(
            { kind: "Agent", name: "nogrant", namespace: NS },
            { name: "bad", agentRef: "nogrant", session: "nogrant-default" },
        ),
        /Capability denied/,
    );
});

test("home controller rejects bootstrap path escapes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-test-"));
    const runtime = await createRuntime(dir).init();
    await runtime.apply({
        kind: "Home",
        metadata: { namespace: "agent-generic", name: "generic-home" },
        spec: { files: [{ path: "../generic-home-evil/readme.md", content: "bad" }] },
    });
    await assert.rejects(runtime.reconcile(), /escapes home/);
});

test("home controller bootstraps generic userland files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-test-"));
    const runtime = await createRuntime(dir).init();
    await runtime.apply({
        kind: "Home",
        metadata: { namespace: "agent-generic", name: "generic-home" },
        spec: {
            layout: { create: ["vault", "bin"] },
            files: [
                { path: "vault/readme.md", content: "hello" },
                { path: "bin/brief", mode: "0755", content: "#!/usr/bin/env bash\necho ok\n" },
            ],
        },
    });
    await runtime.reconcile();
    const home = runtime.state.findByName("Home", "generic-home", "agent-generic");
    assert.equal(await readFile(path.join(home.status.path, "vault/readme.md"), "utf8"), "hello");
});

test("local hands exec rejects host shell escape syntax", () => {
    assert.throws(() => parseConfinedExecCommand("cat /etc/passwd"), /Home-relative executable|Path escapes home/);
    assert.throws(() => parseConfinedExecCommand("bin/tool ../outside"), /Path escapes home/);
    assert.throws(() => parseConfinedExecCommand("bash -lc 'cat /etc/passwd'"), /Home-relative executable|not allowed/);
    assert.throws(() => parseConfinedExecCommand("bin/tool $(cat vault/file)"), /metacharacters/);
    assert.deepEqual(parseConfinedExecCommand("bin/tool vault/file"), ["bin/tool", "vault/file"]);
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
        assert.equal(agents[0].metadata.name, AGENT);
        const response = await fetch(`http://127.0.0.1:${port}/hades/v1/agents/${AGENT}/message`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ namespace: NS, text: "hello" }),
        }).then((res) => res.json());
        assert.match(response.reply, /received: hello/);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("unqualified agent names are rejected when ambiguous", async () => {
    const { runtime } = await runtimeFixture();
    await runtime.apply({ kind: "Agent", metadata: { namespace: "other", name: AGENT }, spec: { homeRef: "other-home" } });
    await assert.rejects(runtime.messageAgent(AGENT, "hello"), /ambiguous/);
});

test("cli help does not initialize state", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "hades-cli-"));
    const result = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "--help"], { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(access(path.join(cwd, ".hades")), /ENOENT/);
});

test("hands reject absolute paths even when inside home", async () => {
    const { runtime } = await runtimeFixture();
    const home = runtime.state.findByName("Home", HOME, NS);
    const hands = new LocalConfinedHands({ homeRoot: home.status.path });
    await assert.rejects(hands.read(path.join(home.status.path, "vault/note.md")), /Absolute paths are not allowed/);
    await assert.rejects(hands.write(path.join(home.status.path, "vault/note.md"), "bad"), /Absolute paths are not allowed/);
    await assert.rejects(hands.exec({ command: "bin/tool", cwd: home.status.path }), /Absolute paths are not allowed/);
});

test("hands reject executable symlinks and denied shebangs", async () => {
    const { runtime } = await runtimeFixture();
    const home = runtime.state.findByName("Home", HOME, NS);
    const hands = new LocalConfinedHands({ homeRoot: home.status.path });
    await symlink("/bin/sh", path.join(home.status.path, "bin/shlink"));
    await assert.rejects(hands.exec({ command: "bin/shlink" }), /symlinks are not allowed/);
    const shellScript = path.join(home.status.path, "bin/script");
    await writeFile(shellScript, "#!/usr/bin/env bash\necho nope\n", "utf8");
    await chmod(shellScript, 0o755);
    await assert.rejects(hands.exec({ command: "bin/script" }), /Shebang interpreter bash is not allowed/);
    const envScript = path.join(home.status.path, "bin/env-script");
    await writeFile(envScript, "#!/usr/bin/env -S FOO=bar bash\necho nope\n", "utf8");
    await chmod(envScript, 0o755);
    await assert.rejects(hands.exec({ command: "bin/env-script" }), /Shebang interpreter bash is not allowed/);
});

test("hands prevent path escape", async () => {
    const { runtime } = await runtimeFixture();
    const home = runtime.state.findByName("Home", HOME, NS);
    const hands = new LocalConfinedHands({ homeRoot: home.status.path });
    await assert.rejects(hands.write("../escape", "bad"), /Path escapes home/);
    await assert.rejects(hands.write(`../${path.basename(home.status.path)}-sibling/file`, "bad"), /Path escapes home/);
});

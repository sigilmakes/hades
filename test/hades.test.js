import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRuntime } from "../dist/runtime/LocalRuntime.js";
import { LocalConfinedHands, sanitizedEnv } from "../dist/adapters/hands/LocalConfinedHands.js";
import { deniedShebangInterpreter, parseConfinedExecCommand } from "../dist/adapters/hands/ConfinedCommandParser.js";
import { isScheduleDue } from "../dist/domain/schedule-due.js";
import { CONFINED_PROFILE } from "../dist/domain/sandbox.js";
import { createServer } from "../dist/adapters/api/server.js";
import { PRIMITIVES } from "../dist/domain/primitives.js";

const NS = "agent-test";
const AGENT = "raven";
const HOME = "raven-home";
const SESSION = "raven-default";

test("build output does not retain removed core or api modules", async () => {
    await assert.rejects(readdir(path.resolve("dist/core")), /ENOENT/);
    await assert.rejects(readdir(path.resolve("dist/api")), /ENOENT/);
});

test("package metadata builds cli package from dist", async () => {
    const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
    assert.equal(packageJson.bin.hades, "dist/cli.js");
    assert.equal(packageJson.scripts.prepack, "npm run build");
    assert.ok(packageJson.files.includes("dist/"));
});

test("primitive catalog adopts useful surfaces and rejects noise", () => {
    const byId = new Map(PRIMITIVES.map((primitive) => [primitive.id, primitive]));
    assert.equal(byId.size, PRIMITIVES.length);
    assert.equal(byId.get("mcp.brokered-tools")?.decision, "adopt");
    assert.equal(byId.get("acp.external-sessions")?.decision, "adopt");
    assert.equal(byId.get("gateway.nodes")?.decision, "adopt");
    assert.equal(byId.get("linux.dbus-raw")?.decision, "reject");
    assert.equal(byId.get("mcp.sidecar-sprawl")?.decision, "reject");
    assert.equal(Object.isFrozen(PRIMITIVES), true);
    assert.equal(Object.isFrozen(byId.get("mcp.brokered-tools")), true);
    assert.equal(Object.isFrozen(byId.get("mcp.brokered-tools")?.mapsToKinds), true);
    assert.equal(Object.isFrozen(byId.get("linux.capabilities-seccomp")?.sources), true);
    assert.equal(Object.isFrozen(byId.get("linux.capabilities-seccomp")?.relatedConcepts), true);
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

test("removed deterministic mode and bang-bash directive fail loudly", async () => {
    const { runtime } = await runtimeFixture();
    assert.throws(
        () => runtime.brain.resolveMode({ kind: "Agent", metadata: { namespace: NS, name: "old-brain" }, spec: { brain: { mode: "deterministic" } } }),
        /Unsupported brain mode deterministic/,
    );
    await assert.rejects(runtime.messageAgent(`${NS}/${AGENT}`, "!bash bin/tool"), /Unsupported test brain directive: !bash/);
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

test("interval schedule fires repeatedly across reconcile passes", async () => {
    const { runtime } = await runtimeFixture();
    await runtime.createSchedule(
        { kind: "Agent", name: AGENT, namespace: NS },
        { name: "every-second", agentRef: AGENT, type: "interval", schedule: "0s", session: SESSION, prompt: "tick" },
    );
    await runtime.reconcile();
    let events = await runtime.events.list(SESSION);
    const fired1 = events.filter((e) => e.type === "schedule.fired").length;
    assert.ok(fired1 >= 1, "interval should fire on first reconcile");
    // advance lastFiredAt into the past so it is due again
    const sched = runtime.state.findByName("Schedule", "every-second", NS);
    sched.status.lastFiredAt = new Date(Date.now() - 60_000).toISOString();
    await runtime.reconcile();
    events = await runtime.events.list(SESSION);
    const fired2 = events.filter((e) => e.type === "schedule.fired").length;
    assert.ok(fired2 > fired1, "interval should fire again once lastFiredAt is stale");
    assert.equal(sched.status.phase, "active");
});

test("cron schedule is due on first matching minute and guarded within the same minute", () => {
    const createdAt = new Date(Date.now() - 120_000).toISOString();
    const now = Date.now();
    // never fired -> due on the current matching minute
    assert.equal(isScheduleDue({ type: "cron", schedule: "* * * * *" }, undefined, createdAt, now), true);
    // already fired this minute -> not due again until the minute rolls over
    const lastFiredThisMinute = new Date(now).toISOString();
    assert.equal(isScheduleDue({ type: "cron", schedule: "* * * * *" }, lastFiredThisMinute, createdAt, now), false);
    // fired in a previous minute -> due again
    const lastFiredPrevMinute = new Date(now - 120_000).toISOString();
    assert.equal(isScheduleDue({ type: "cron", schedule: "* * * * *" }, lastFiredPrevMinute, createdAt, now), true);
});

test("cron schedule fires once per matching minute across reconciles", async () => {
    const { runtime } = await runtimeFixture();
    await runtime.createSchedule(
        { kind: "Agent", name: AGENT, namespace: NS },
        { name: "every-minute", agentRef: AGENT, type: "cron", schedule: "* * * * *", session: SESSION, prompt: "cron tick" },
    );
    await runtime.reconcile();
    const fired1 = (await runtime.events.list(SESSION)).filter((e) => e.type === "schedule.fired").length;
    assert.ok(fired1 >= 1, "cron matching the current minute should fire");
    // second reconcile within the same minute must not fire again
    await runtime.reconcile();
    const fired2 = (await runtime.events.list(SESSION)).filter((e) => e.type === "schedule.fired").length;
    assert.equal(fired2, fired1, "cron must not fire twice for the same matching minute");
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
    assert.throws(() => parseConfinedExecCommand("cat /etc/passwd", CONFINED_PROFILE), /Home-relative executable|Path escapes home/);
    assert.throws(() => parseConfinedExecCommand("bin/tool ../outside", CONFINED_PROFILE), /Path escapes home/);
    assert.throws(() => parseConfinedExecCommand("bash -lc 'cat /etc/passwd'", CONFINED_PROFILE), /Home-relative executable|not allowed/);
    assert.throws(() => parseConfinedExecCommand("bin/tool $(cat vault/file)", CONFINED_PROFILE), /metacharacters/);
    assert.deepEqual(parseConfinedExecCommand("bin/tool vault/file", CONFINED_PROFILE), ["bin/tool", "vault/file"]);
});

test("hands env does not expose secret-like variables", () => {
    process.env.HADES_FAKE_SECRET = "nope";
    process.env.HADES_FAKE_TOKEN = "nope";
    try {
        const env = sanitizedEnv();
        assert.equal(env.HADES_FAKE_SECRET, undefined);
        assert.equal(env.HADES_FAKE_TOKEN, undefined);
        assert.equal(env.HADES_HANDS, "1");
    } finally {
        delete process.env.HADES_FAKE_SECRET;
        delete process.env.HADES_FAKE_TOKEN;
    }
});

test("sandbox policy is parameterized so a permissive profile would allow interpreters", () => {
    const permissive = {
        id: "permissive-container",
        deniedInterpreters: new Set(),
        denyEnvPatterns: [],
        allowShellMetachars: true,
        requireHomeRelativeExecutable: false,
        timeoutMs: 30000,
    };
    assert.deepEqual(parseConfinedExecCommand("bash -lc 'echo hi'", permissive), ["bash", "-lc", "echo hi"]);
    assert.equal(deniedShebangInterpreter("#!/usr/bin/env bash\n", permissive), undefined);
});

test("API exposes agents, primitives, and message endpoint", async () => {
    const { runtime } = await runtimeFixture();
    const server = createServer(runtime);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    try {
        const agents = await fetch(`http://127.0.0.1:${port}/hades/v1/agents`).then((res) => res.json());
        assert.equal(agents[0].metadata.name, AGENT);
        const allPrimitives = await fetch(`http://127.0.0.1:${port}/hades/v1/primitives`).then((res) => res.json());
        assert.ok(allPrimitives.some((primitive) => primitive.decision === "adopt"));
        assert.ok(allPrimitives.some((primitive) => primitive.decision === "reject"));
        const primitives = await fetch(`http://127.0.0.1:${port}/hades/v1/primitives?decision=adopt`).then((res) => res.json());
        assert.ok(primitives.some((primitive) => primitive.id === "scripting.sandbox"));
        assert.ok(primitives.every((primitive) => primitive.decision === "adopt"));
        const deferred = await fetch(`http://127.0.0.1:${port}/hades/v1/primitives?decision=defer`).then((res) => res.json());
        assert.ok(deferred.length > 0);
        assert.ok(deferred.every((primitive) => primitive.decision === "defer"));
        assert.deepEqual(allPrimitives.map((primitive) => `${primitive.layer}/${primitive.id}`), [...allPrimitives].map((primitive) => `${primitive.layer}/${primitive.id}`).sort());
        const invalidPrimitiveResponse = await fetch(`http://127.0.0.1:${port}/hades/v1/primitives?decision=garbage`);
        assert.equal(invalidPrimitiveResponse.status, 400);
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

test("candidate primitive resources are not accepted before behavior exists", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-test-"));
    const runtime = await createRuntime(dir).init();
    const candidateKinds = ["Gateway", "Node", "ToolProvider", "Workflow", "ExternalSession", "SandboxProfile", "SecretLease"];
    const crds = await readFile(path.resolve("deploy/crds/hades.dev_resources.yaml"), "utf8");
    for (const kind of candidateKinds) {
        await assert.rejects(
            runtime.apply({ kind, metadata: { namespace: "hades-system", name: "candidate" }, spec: {} }),
            new RegExp(`Unsupported kind ${kind}`),
        );
        assert.equal(crds.includes(`kind: ${kind}`), false, `${kind} should not have a CRD before behavior exists`);
    }
});

test("cli primitives lists adopted primitives without initializing state", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "hades-cli-"));
    const result = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "primitives", "adopt"], { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const primitives = JSON.parse(result.stdout);
    assert.ok(primitives.some((primitive) => primitive.id === "mcp.brokered-tools"));
    assert.ok(primitives.every((primitive) => primitive.decision === "adopt"));
    await assert.rejects(access(path.join(cwd, ".hades")), /ENOENT/);
    const deferred = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "primitives", "defer"], { cwd, encoding: "utf8" });
    assert.equal(deferred.status, 0, deferred.stderr);
    assert.ok(JSON.parse(deferred.stdout).every((primitive) => primitive.decision === "defer"));
    const invalid = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "primitives", "garbage"], { cwd, encoding: "utf8" });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /Unknown primitive decision garbage/);
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

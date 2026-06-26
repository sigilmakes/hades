import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime } from "../dist/runtime/HadesRuntime.js";
import { createServer } from "../dist/adapters/api/server.js";

const NS = "syscall-test";
const AGENT = "wren";
const HOME = "wren-home";
const SESSION = "wren-default";

async function fixture() {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-syscall-"));
    const runtime = await (await createRuntime(dir)).init();
    await runtime.apply({ kind: "Home", metadata: { namespace: NS, name: HOME }, spec: {} });
    await runtime.apply({ kind: "Agent", metadata: { namespace: NS, name: AGENT }, spec: { homeRef: HOME, defaultSession: SESSION, desiredState: "active", brain: { mode: "test" } } });
    return { dir, runtime };
}

const subject = { kind: "Agent", name: AGENT, namespace: NS };

test("os.createAgent is denied without the createAgent capability", async () => {
    const { runtime } = await fixture();
    await assert.rejects(runtime.syscalls.createAgent(subject, { name: "muse" }), /Capability denied/);
    assert.equal(runtime.state.findByName("Agent", "muse", NS), undefined);
});

test("os.createAgent mints a resident agent when permitted", async () => {
    const { runtime } = await fixture();
    await runtime.apply({ kind: "CapabilityGrant", metadata: { namespace: NS, name: "g" }, spec: { subject: { kind: "Agent", name: AGENT }, capabilities: ["createAgent"], constraints: { namespace: "own" } } });
    const agent = await runtime.syscalls.createAgent(subject, { name: "muse", brain: { mode: "test" } });
    assert.equal(agent.kind, "Agent");
    assert.equal(agent.metadata.name, "muse");
    assert.equal(agent.spec.lifecycle, "resident");
    assert.equal(agent.status.createdBy, AGENT);
    const sys = await runtime.events.list("system");
    assert.ok(sys.some((e) => e.type === "syscall.audited" && e.payload.capability === "createAgent"));
});

test("os.createHome is denied without the createHome capability", async () => {
    const { runtime } = await fixture();
    await assert.rejects(runtime.syscalls.createHome(subject, { name: "extra-home" }), /Capability denied/);
});

test("os.createHome provisions a home when permitted", async () => {
    const { runtime } = await fixture();
    await runtime.apply({ kind: "CapabilityGrant", metadata: { namespace: NS, name: "g" }, spec: { subject: { kind: "Agent", name: AGENT }, capabilities: ["createHome"], constraints: { namespace: "own" } } });
    const home = await runtime.syscalls.createHome(subject, { name: "extra-home", layout: { create: ["vault"] } });
    assert.equal(home.kind, "Home");
    assert.equal(home.metadata.name, "extra-home");
});

test("os.attachListener attaches a platform listener when permitted", async () => {
    const { runtime } = await fixture();
    await runtime.apply({ kind: "CapabilityGrant", metadata: { namespace: NS, name: "g" }, spec: { subject: { kind: "Agent", name: AGENT }, capabilities: ["attachListener"], constraints: { namespace: "own" } } });
    const listener = await runtime.syscalls.attachListener(subject, { name: "wren-discord", platform: "discord", secretRef: "discord-token" });
    assert.equal(listener.kind, "Listener");
    assert.equal(listener.spec.platform, "discord");
    assert.equal(listener.spec.agentRef, AGENT);
});

test("os.requestApproval creates a resumable approval gate", async () => {
    const { runtime } = await fixture();
    await runtime.apply({ kind: "CapabilityGrant", metadata: { namespace: NS, name: "g" }, spec: { subject: { kind: "Agent", name: AGENT }, capabilities: ["requestApproval", "respondApproval"], constraints: { namespace: "own" } } });
    const approval = await runtime.syscalls.requestApproval(subject, { name: "deploy-prod", action: "deploy", reason: "ship v2", resource: "deployment/prod" });
    assert.equal(approval.status.phase, "requested");
    assert.equal(runtime.syscalls.isApproved("deploy-prod", NS), false);
    // Human responds.
    const decided = await runtime.syscalls.respondApproval(subject, "deploy-prod", "approve", "looks good");
    assert.equal(decided.status.phase, "approved");
    assert.equal(decided.status.decidedBy, AGENT);
    assert.equal(runtime.syscalls.isApproved("deploy-prod", NS), true);
    const sys = await runtime.events.list("system");
    assert.ok(sys.some((e) => e.type === "approval.requested"));
    assert.ok(sys.some((e) => e.type === "approval.responded" && e.payload.decision === "approve"));
});

test("os.requestApproval denies without the capability", async () => {
    const { runtime } = await fixture();
    await assert.rejects(runtime.syscalls.requestApproval(subject, { name: "x", action: "deploy" }), /Capability denied/);
});

test("respondApproval rejects a decision on an already-decided approval", async () => {
    const { runtime } = await fixture();
    await runtime.apply({ kind: "CapabilityGrant", metadata: { namespace: NS, name: "g" }, spec: { subject: { kind: "Agent", name: AGENT }, capabilities: ["requestApproval", "respondApproval"], constraints: { namespace: "own" } } });
    await runtime.syscalls.requestApproval(subject, { name: "once", action: "x" });
    await runtime.syscalls.respondApproval(subject, "once", "approve");
    await assert.rejects(runtime.syscalls.respondApproval(subject, "once", "deny"), /already/);
});

test("os.emitArtifact records an artifact reference", async () => {
    const { runtime } = await fixture();
    await runtime.apply({ kind: "CapabilityGrant", metadata: { namespace: NS, name: "g" }, spec: { subject: { kind: "Agent", name: AGENT }, capabilities: ["emitArtifact"], constraints: { namespace: "own" } } });
    const artifact = await runtime.syscalls.emitArtifact(subject, { name: "report", artifactRef: "vault/reports/q2.md", summary: "Q2 report" });
    assert.equal(artifact.kind, "Run");
    assert.match(artifact.metadata.name, /artifact-report-/);
    const sys = await runtime.events.list("system");
    assert.ok(sys.some((e) => e.type === "syscall.audited" && e.payload.capability === "emitArtifact"));
});

test("syscalls cannot target another namespace", async () => {
    const { runtime } = await fixture();
    await runtime.apply({ kind: "CapabilityGrant", metadata: { namespace: NS, name: "g" }, spec: { subject: { kind: "Agent", name: AGENT }, capabilities: ["createAgent"], constraints: { namespace: "own" } } });
    await assert.rejects(runtime.syscalls.createAgent(subject, { name: "x", namespace: "other" }), /cannot target another namespace/);
});

test("permittedSyscalls lists the capabilities an agent currently holds", async () => {
    const { runtime } = await fixture();
    assert.ok(!runtime.syscalls.permittedSyscalls(subject).includes("createAgent"));
    await runtime.apply({ kind: "CapabilityGrant", metadata: { namespace: NS, name: "g" }, spec: { subject: { kind: "Agent", name: AGENT }, capabilities: ["createAgent", "emitArtifact"], constraints: { namespace: "own" } } });
    const permitted = runtime.syscalls.permittedSyscalls(subject);
    assert.ok(permitted.includes("createAgent"));
    assert.ok(permitted.includes("emitArtifact"));
    assert.ok(!permitted.includes("spawnAgent"));
});

test("syscall API endpoints are policy-checked", async () => {
    const { runtime } = await fixture();
    const server = createServer(runtime);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    try {
        // Denied without the capability.
        const denied = await fetch(`http://127.0.0.1:${port}/hades/v1/syscalls/create-agent`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ subject, spec: { name: "muse" } }),
        });
        assert.equal(denied.status, 403);
        // Grant and retry.
        await runtime.apply({ kind: "CapabilityGrant", metadata: { namespace: NS, name: "g" }, spec: { subject: { kind: "Agent", name: AGENT }, capabilities: ["createAgent"], constraints: { namespace: "own" } } });
        const ok = await fetch(`http://127.0.0.1:${port}/hades/v1/syscalls/create-agent`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ subject, spec: { name: "muse" } }),
        });
        assert.equal(ok.status, 200);
        const okJson = await ok.json();
        assert.equal(okJson.metadata.name, "muse");
        // Permitted introspection.
        const perm = await fetch(`http://127.0.0.1:${port}/hades/v1/syscalls/permitted?name=${AGENT}&namespace=${NS}`).then((r) => r.json());
        assert.ok(perm.includes("createAgent"));
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

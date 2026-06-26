import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRuntime } from "../dist/runtime/HadesRuntime.js";
import { FakeKubeClient } from "../dist/adapters/kube/FakeKubeClient.js";
import { SkillRegistry, SKILL_CATALOG } from "../dist/services/SkillRegistry.js";
import { createServer } from "../dist/adapters/api/server.js";

const NS = "agent-atlas";
const AGENT = "atlas";
const HOME = "atlas-home";
const SESSION = "atlas-default";

async function fixture() {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-skillcat-"));
    const kube = new FakeKubeClient();
    const rt = await (await createRuntime(dir, { kubeClient: kube })).init();
    await rt.apply({ kind: "Home", metadata: { namespace: NS, name: HOME }, spec: {} });
    await rt.apply({ kind: "Agent", metadata: { namespace: NS, name: AGENT }, spec: { homeRef: HOME, defaultSession: SESSION, desiredState: "active", brain: { mode: "test" } } });
    await rt.apply({ kind: "CapabilityGrant", metadata: { namespace: NS, name: "g" }, spec: { subject: { kind: "Agent", name: AGENT }, capabilities: ["publishSkill", "attachConnector"], constraints: { namespace: "own" } } });
    return { dir, rt, kube };
}

test("the skill catalog ships with at least the default webhook + http-fetch entries", () => {
    const reg = new SkillRegistry();
    const names = reg.list().map((e) => e.name);
    assert.ok(names.includes("webhook"), "webhook is cataloged");
    assert.ok(names.includes("http-fetch"), "http-fetch is cataloged");
    // Each entry points at a userland image — the kernel never contains the body.
    for (const entry of reg.list()) {
        assert.ok(entry.image, `${entry.name} has an image`);
        assert.ok(entry.port > 0, `${entry.name} has a port`);
    }
});

test("SkillRegistry.find resolves a known entry and rejects unknown", () => {
    const reg = new SkillRegistry();
    assert.equal(reg.find("webhook")?.name, "webhook");
    assert.equal(reg.find("nope"), undefined);
    assert.equal(reg.has("http-fetch"), true);
    assert.equal(reg.has("nope"), false);
});

test("installSkill resolves a catalog entry into a live Skill CRD + reconciles a Service", async () => {
    const { rt, kube } = await fixture();
    const { skill } = await rt.installSkill({ kind: "Agent", name: AGENT, namespace: NS }, "webhook", { agentRef: AGENT, namespace: NS });
    assert.equal(skill.kind, "Skill");
    assert.equal(skill.spec.catalog, "webhook", "records the catalog source");
    assert.equal(skill.spec.image, SKILL_CATALOG[0].image, "carries the userland image");
    assert.equal(skill.metadata?.name, `${AGENT}-webhook`);
    await rt.reconcile();
    const svc = await kube.get(NS, "Service", `skill-${AGENT}-webhook`);
    assert.ok(svc, "catalog skill reconciled into a Service");
    const stored = rt.state.get("Skill", NS, `${AGENT}-webhook`);
    assert.equal(stored.status.phase, "exposed");
});

test("installSkill on an unknown skill name errors clearly", async () => {
    const { rt } = await fixture();
    await assert.rejects(
        rt.installSkill({ kind: "Agent", name: AGENT, namespace: NS }, "not-a-skill", { agentRef: AGENT, namespace: NS }),
        /Unknown skill 'not-a-skill'/,
    );
});

test("GET /hades/v1/skills/catalog returns the installable entries", async () => {
    const { rt } = await fixture();
    const server = createServer(rt);
    await new Promise((r) => server.listen(0, r));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/hades/v1/skills/catalog`);
        const body = await res.json();
        assert.equal(res.status, 200);
        assert.ok(body.skills.length >= 2);
        assert.ok(body.skills.some((s) => s.name === "webhook"));
    } finally { await new Promise((r) => server.close(r)); }
});

test("POST /hades/v1/syscalls/install-skill installs a catalog skill via the API", async () => {
    const { rt } = await fixture();
    const server = createServer(rt);
    await new Promise((r) => server.listen(0, r));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/hades/v1/syscalls/install-skill`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ subject: { kind: "Agent", name: AGENT, namespace: NS }, skill: "http-fetch", agentRef: AGENT, namespace: NS }),
        });
        const body = await res.json();
        assert.equal(res.status, 200);
        assert.equal(body.skill.kind, "Skill");
        assert.equal(body.skill.spec.catalog, "http-fetch");
    } finally { await new Promise((r) => server.close(r)); }
});

test("a catalog skill a second agent calls via a Connector round-trips the catalog image", async () => {
    // Symmetry: atlas installs the webhook skill (exposes); a second connector
    // targets the skill's reconciled endpoint (consumes). The catalog image is
    // recorded on the Skill spec, not interpreted by the kernel.
    const { rt } = await fixture();
    await rt.installSkill({ kind: "Agent", name: AGENT, namespace: NS }, "webhook", { agentRef: AGENT, namespace: NS });
    await rt.reconcile();
    const skill = rt.state.get("Skill", NS, `${AGENT}-webhook`);
    assert.ok(skill.status.endpoint, "skill has a cluster endpoint");
    await rt.apply({ kind: "Connector", metadata: { namespace: NS, name: "webhook-client" }, spec: { agentRef: AGENT, endpoint: skill.status.endpoint, egress: "none" } });
    await rt.reconcile();
    const conn = rt.state.get("Connector", NS, "webhook-client");
    assert.equal(conn.status.phase, "ready");
    assert.equal(conn.spec.endpoint, skill.status.endpoint);
});

test("CLI: hades skills lists the catalog", () => {
    const result = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "skills"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Installable skills/);
    assert.match(result.stdout, /webhook/);
});

test("CLI: hades install skill creates the Skill CRD and reconciles", () => {
    const dir = spawnSync("mktemp", ["-d"], { encoding: "utf8" }).stdout.trim();
    // Set up an agent to install onto (alpha.json creates agent-demo/demo).
    spawnSync(process.execPath, [path.resolve("dist/cli.js"), "init"], { cwd: dir, encoding: "utf8", env: { ...process.env, HADES_DATA_DIR: dir, HADES_OBSERVABILITY: "off" } });
    spawnSync(process.execPath, [path.resolve("dist/cli.js"), "apply", path.resolve("examples/generic/alpha.json")], { cwd: dir, encoding: "utf8", env: { ...process.env, HADES_DATA_DIR: dir, HADES_OBSERVABILITY: "off" } });
    const result = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "install", "skill", "webhook", "--agent", "demo", "--namespace", "agent-demo"], { cwd: dir, encoding: "utf8", env: { ...process.env, HADES_DATA_DIR: dir, HADES_OBSERVABILITY: "off" } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /installed skill webhook onto/);
    // The Skill CRD is now in state.
    const get = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "get", "skills", "--namespace", "agent-demo"], { cwd: dir, encoding: "utf8", env: { ...process.env, HADES_DATA_DIR: dir, HADES_OBSERVABILITY: "off" } });
    assert.match(get.stdout, /demo-webhook/);
});

test("CLI: hades install skill rejects an unknown skill", () => {
    const dir = spawnSync("mktemp", ["-d"], { encoding: "utf8" }).stdout.trim();
    const result = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "install", "skill", "nope", "--agent", "demo"], { cwd: dir, encoding: "utf8", env: { ...process.env, HADES_DATA_DIR: dir, HADES_OBSERVABILITY: "off" } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown skill 'nope'/);
});

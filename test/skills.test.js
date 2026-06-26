import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime } from "../dist/runtime/HadesRuntime.js";
import { FakeKubeClient } from "../dist/adapters/kube/FakeKubeClient.js";

const NS = "agent-atlas";
const AGENT = "atlas";
const HOME = "atlas-home";
const SESSION = "atlas-default";

async function fixture() {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-skill-"));
    const kube = new FakeKubeClient();
    const rt = await (await createRuntime(dir, { kubeClient: kube })).init();
    await rt.apply({ kind: "Home", metadata: { namespace: NS, name: HOME }, spec: {} });
    await rt.apply({ kind: "Agent", metadata: { namespace: NS, name: AGENT }, spec: { homeRef: HOME, defaultSession: SESSION, desiredState: "active", brain: { mode: "test" } } });
    await rt.apply({ kind: "CapabilityGrant", metadata: { namespace: NS, name: "g" }, spec: { subject: { kind: "Agent", name: AGENT }, capabilities: ["publishSkill", "attachConnector"], constraints: { namespace: "own" } } });
    return { dir, rt, kube };
}

test("publishSkill is capability-gated + creates a Skill", async () => {
    const { rt } = await fixture();
    const skill = await rt.syscalls.publishSkill({ kind: "Agent", name: AGENT, namespace: NS }, { name: "search", port: 8080, description: "full-text search" });
    assert.equal(skill.kind, "Skill");
    assert.equal(skill.spec.port, 8080);
    // Denied without the capability.
    await rt.apply({ kind: "Home", metadata: { namespace: NS, name: "stranger-home" }, spec: {} });
    await rt.apply({ kind: "Agent", metadata: { namespace: NS, name: "stranger" }, spec: { homeRef: "stranger-home", defaultSession: "stranger-default", desiredState: "active", brain: { mode: "test" } } });
    await assert.rejects(
        rt.syscalls.publishSkill({ kind: "Agent", name: "stranger", namespace: NS }, { name: "nope" }),
        /Capability denied/,
    );
});

test("controller reconciles a Skill into a Service exposing the brain pod", async () => {
    const { rt, kube } = await fixture();
    await rt.apply({ kind: "Skill", metadata: { namespace: NS, name: "search" }, spec: { agentRef: AGENT, port: 8080, description: "search" } });
    await rt.reconcile();
    const svc = await kube.get(NS, "Service", "skill-search");
    assert.ok(svc, "skill Service ensured");
    assert.equal(svc.spec.selector["hades.dev/agent"], AGENT, "targets the brain pod");
    assert.equal(svc.spec.ports[0].port, 8080);
    const skill = rt.state.get("Skill", NS, "search");
    assert.equal(skill.status.phase, "exposed");
    assert.match(skill.status.endpoint, /http:\/\/skill-search\.agent-atlas\.svc\.cluster\.local:8080/);
});

test("a Skill's cluster endpoint is addressable by another agent's Connector", async () => {
    // Symmetry: one agent exposes (Skill), another consumes (Connector targeting it).
    const { rt } = await fixture();
    await rt.apply({ kind: "Skill", metadata: { namespace: NS, name: "search" }, spec: { agentRef: AGENT, port: 8080 } });
    await rt.reconcile();
    const skill = rt.state.get("Skill", NS, "search");
    // A second agent wires a Connector to the skill's status.endpoint.
    await rt.apply({ kind: "Connector", metadata: { namespace: NS, name: "search-client" }, spec: { agentRef: AGENT, endpoint: skill.status.endpoint, egress: "none" } });
    await rt.reconcile();
    const conn = rt.state.get("Connector", NS, "search-client");
    assert.equal(conn.status.phase, "ready");
    assert.equal(conn.spec.endpoint, skill.status.endpoint, "connector targets the skill's published endpoint");
});

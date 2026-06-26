import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime } from "../dist/runtime/HadesRuntime.js";
import { SystemAgents } from "../dist/services/SystemAgents.js";

test("system agents are bootstrapped on reconcile in the hades-system namespace", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-sysag-"));
    const runtime = await (await createRuntime(dir)).init();
    await runtime.reconcile();
    for (const name of SystemAgents.NAMES) {
        const agent = runtime.state.findByName("Agent", name, SystemAgents.NAMESPACE);
        assert.ok(agent, `${name} agent should exist`);
        assert.equal(agent.spec.systemAgent, true);
        assert.equal(agent.spec.lifecycle, "resident");
        assert.ok(runtime.state.findByName("Home", `${name}-home`, SystemAgents.NAMESPACE), `${name} home should exist`);
        const grant = runtime.state.findByName("CapabilityGrant", `${name}-system-grant`, SystemAgents.NAMESPACE);
        assert.ok(grant, `${name} system grant should exist`);
        assert.deepEqual(grant.spec.capabilities, SystemAgents.capabilitiesFor(name));
        assert.equal(grant.spec.constraints.systemGrant, true);
    }
});

test("provisioner has create/create/attach capabilities; janitor has cleanup; auditor has read/report", () => {
    assert.deepEqual(SystemAgents.capabilitiesFor("provisioner"), ["createAgent", "createHome", "attachListener", "createOwnSchedule", "spawnAgent"]);
    assert.deepEqual(SystemAgents.capabilitiesFor("janitor"), ["deleteExpiredHands", "deleteExpiredRuns", "listResources", "emitArtifact"]);
    assert.deepEqual(SystemAgents.capabilitiesFor("auditor"), ["readPolicy", "listResources", "emitArtifact", "requestApproval"]);
});

test("system agents reconcile is idempotent (no duplicate grants)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-sysag-"));
    const runtime = await (await createRuntime(dir)).init();
    await runtime.reconcile();
    await runtime.reconcile();
    await runtime.reconcile();
    const grants = runtime.state.list("CapabilityGrant", SystemAgents.NAMESPACE);
    assert.equal(grants.length, 3, "exactly one grant per system agent");
});

test("system agents emit creation events", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-sysag-"));
    const runtime = await (await createRuntime(dir)).init();
    await runtime.reconcile();
    const sys = await runtime.events.list("system");
    assert.ok(sys.some((e) => e.type === "system-agent.created" && e.payload.agent === "provisioner"));
    assert.ok(sys.some((e) => e.type === "system-agent.granted" && e.payload.agent === "auditor"));
});

test("system agents are bootstrapped in distributed mode too", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-sysag-dist-"));
    const dist = await (await createRuntime(dir)).init();
    await dist.reconcile();
    assert.ok(dist.state.findByName("Agent", "provisioner", SystemAgents.NAMESPACE));
    assert.ok(dist.state.findByName("Agent", "janitor", SystemAgents.NAMESPACE));
    assert.ok(dist.state.findByName("Agent", "auditor", SystemAgents.NAMESPACE));
});

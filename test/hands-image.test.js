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
    const dir = await mkdtemp(path.join(tmpdir(), "hades-img-"));
    const kube = new FakeKubeClient();
    const rt = await (await createRuntime(dir, { kubeClient: kube })).init();
    await rt.apply({ kind: "Home", metadata: { namespace: NS, name: HOME }, spec: {} });
    await rt.apply({ kind: "Agent", metadata: { namespace: NS, name: AGENT }, spec: { homeRef: HOME, defaultSession: SESSION, desiredState: "active", brain: { mode: "test" } } });
    await rt.apply({ kind: "CapabilityGrant", metadata: { namespace: NS, name: "g" }, spec: { subject: { kind: "Agent", name: AGENT }, capabilities: ["installPackages"], constraints: { namespace: "own" } } });
    return { dir, rt, kube };
}

test("installPackages is capability-gated + creates a HandsImage", async () => {
    const { rt } = await fixture();
    const image = await rt.syscalls.installPackages({ kind: "Agent", name: AGENT, namespace: NS }, { packages: ["ripgrep", "fd"] });
    assert.equal(image.kind, "HandsImage");
    assert.deepEqual(image.spec.packages, ["ripgrep", "fd"]);
    // Denied without the capability: a different agent (exists, but no grant).
    await rt.apply({ kind: "Home", metadata: { namespace: NS, name: "stranger-home" }, spec: {} });
    await rt.apply({ kind: "Agent", metadata: { namespace: NS, name: "stranger" }, spec: { homeRef: "stranger-home", defaultSession: "stranger-default", desiredState: "active", brain: { mode: "test" } } });
    await assert.rejects(
        rt.syscalls.installPackages({ kind: "Agent", name: "stranger", namespace: NS }, { packages: ["x"] }),
        /Capability denied/,
    );
});

test("installPackages rejects an empty package list", async () => {
    const { rt } = await fixture();
    await assert.rejects(
        rt.syscalls.installPackages({ kind: "Agent", name: AGENT, namespace: NS }, { packages: [] }),
        /non-empty packages array/,
    );
});

test("controller reconciles a HandsImage into an idempotent build Job", async () => {
    const { rt, kube } = await fixture();
    await rt.apply({ kind: "HandsImage", metadata: { namespace: NS, name: "atlas-hands" }, spec: { packages: ["ripgrep"] } });
    await rt.reconcile();
    // The build Job exists, named by the package digest.
    const jobs = (await kube.list(NS, "Job")).filter((j) => j.metadata.labels?.["hades.dev/build"] === "atlas-hands");
    assert.equal(jobs.length, 1, "one build Job created");
    const firstJobName = jobs[0].metadata.name;
    // Re-reconcile does NOT create a second Job (idempotent per digest).
    await rt.reconcile();
    const jobs2 = (await kube.list(NS, "Job")).filter((j) => j.metadata.labels?.["hades.dev/build"] === "atlas-hands");
    assert.equal(jobs2.length, 1, "no duplicate build Job");
    assert.equal(jobs2[0].metadata.name, firstJobName);
    // Status reflects building.
    const img = rt.state.get("HandsImage", NS, "atlas-hands");
    assert.equal(img.status.phase, "building");
    assert.match(img.status.tag, /hands-atlas-hands:/);
});

test("a Hands pod referencing a HandsImage uses the built image tag", async () => {
    const { rt, kube } = await fixture();
    await rt.apply({ kind: "HandsImage", metadata: { namespace: NS, name: "atlas-hands" }, spec: { packages: ["ripgrep"] } });
    // The agent declares its handsImageRef; the system home-shell inherits it.
    const atlas = rt.state.get("Agent", NS, AGENT);
    await rt.apply({ ...atlas, spec: { ...atlas.spec, handsImageRef: "atlas-hands" } });
    await rt.reconcile();
    const handsDep = await kube.get(NS, "Deployment", `hands-${AGENT}`);
    const container = handsDep.spec.template.spec.containers[0];
    // The pod uses the resolved tag (status.tag), not the default node image.
    assert.match(container.image, /hands-atlas-hands:/, "hands pod uses the built image tag");
});

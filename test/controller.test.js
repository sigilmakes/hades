import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDistributedRuntime } from "../dist/runtime/DistributedRuntime.js";
import { FakeKubeClient } from "../dist/adapters/kube/FakeKubeClient.js";
import { KubeController, toCronExpression } from "../dist/controller/KubeController.js";
import { SqliteStateStore } from "../dist/adapters/store/SqliteStateStore.js";
import { SqliteEventStore } from "../dist/adapters/store/SqliteEventStore.js";

const NS = "ctrl-test";
const AGENT = "wren";
const HOME = "wren-home";

async function fixture() {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-ctrl-"));
    const kube = new FakeKubeClient();
    const state = new SqliteStateStore(dir);
    const events = new SqliteEventStore(dir);
    const dist = await createDistributedRuntime(dir, { kubeClient: kube, stateStore: state, eventStore: events }).init();
    await dist.apply({ kind: "Home", metadata: { namespace: NS, name: HOME }, spec: {} });
    await dist.apply({ kind: "Agent", metadata: { namespace: NS, name: AGENT }, spec: { homeRef: HOME, defaultSession: `${AGENT}-default`, desiredState: "active", brain: { mode: "test" } } });
    return { dir, dist, kube, state, events };
}

test("controller reconciles an Agent into a brain Deployment + Service", async () => {
    const { dist, kube } = await fixture();
    await dist.reconcile();
    const brainDep = kube.get(NS, "Deployment", `brain-${AGENT}`);
    assert.ok(brainDep, "brain Deployment should be ensured");
    assert.equal(brainDep.kind, "Deployment");
    assert.equal(brainDep.spec.replicas, 1);
    assert.ok(brainDep.metadata.ownerReferences?.some((o) => o.kind === "Agent" && o.name === AGENT), "brain Deployment should be owned by the Agent");
    const brainSvc = kube.get(NS, "Service", `brain-${AGENT}`);
    assert.ok(brainSvc, "brain Service should be ensured");
    assert.equal(brainSvc.spec.selector["hades.dev/agent"], AGENT);
});

test("controller reconciles a Home into a PersistentVolumeClaim", async () => {
    const { dist, kube } = await fixture();
    await dist.reconcile();
    const pvc = kube.get(NS, "PersistentVolumeClaim", `home-${HOME}`);
    assert.ok(pvc, "home PVC should be ensured");
    assert.equal(pvc.spec.accessModes[0], "ReadWriteOnce");
    assert.ok(pvc.spec.resources.requests.storage, "PVC should request storage");
    // storageClassName must be unset so the cluster default applies (D3).
    assert.equal(pvc.spec.storageClassName, undefined);
});

test("controller reconciles a Hands resource into a Deployment + Service mounting the home PVC", async () => {
    const { dist, kube } = await fixture();
    await dist.apply({ kind: "Agent", metadata: { namespace: NS, name: "corvus" }, spec: { homeRef: "corvus-home", defaultSession: "corvus-default", desiredState: "active", brain: { mode: "test" } } });
    await dist.apply({ kind: "Home", metadata: { namespace: NS, name: "corvus-home" }, spec: {} });
    await dist.reconcile();
    const handsDep = kube.get(NS, "Deployment", `hands-corvus`);
    assert.ok(handsDep, "hands Deployment should be ensured");
    const vol = handsDep.spec.template.spec.volumes[0];
    assert.equal(vol.persistentVolumeClaim.claimName, "home-corvus-home", "hands pod should mount the home PVC");
});

test("controller reconciles a cron Schedule into a k8s CronJob", async () => {
    const { dist, kube } = await fixture();
    await dist.apply({ kind: "Schedule", metadata: { namespace: NS, name: "tick" }, spec: { agentRef: AGENT, type: "cron", schedule: "*/5 * * * *", session: `${AGENT}-default`, prompt: "tick" } });
    await dist.reconcile();
    const cronJob = kube.get(NS, "CronJob", `sched-tick`);
    assert.ok(cronJob, "CronJob should be ensured");
    assert.equal(cronJob.spec.schedule, "*/5 * * * *");
    assert.ok(cronJob.metadata.ownerReferences?.some((o) => o.kind === "Schedule"));
});

test("controller reconciles an interval Schedule into a CronJob via toCronExpression", async () => {
    const { dist, kube } = await fixture();
    await dist.apply({ kind: "Schedule", metadata: { namespace: NS, name: "every-min" }, spec: { agentRef: AGENT, type: "interval", schedule: "1m", session: `${AGENT}-default`, prompt: "hi" } });
    await dist.reconcile();
    const cronJob = kube.get(NS, "CronJob", `sched-every-min`);
    assert.ok(cronJob);
    assert.equal(cronJob.spec.schedule, "*/1 * * * *");
});

test("toCronExpression converts interval s/m/h correctly", () => {
    assert.equal(toCronExpression({ type: "interval", schedule: "30s" }), "*/30 * * * *");
    assert.equal(toCronExpression({ type: "interval", schedule: "5m" }), "*/5 * * * *");
    assert.equal(toCronExpression({ type: "interval", schedule: "2h" }), "0 */2 * * *");
    assert.equal(toCronExpression({ type: "cron", schedule: "0 0 * * *" }), "0 0 * * *");
    assert.throws(() => toCronExpression({ type: "interval", schedule: "5x" }), /Invalid interval/);
});

test("controller cascades brain/hands deletion when an ephemeral agent is completed", async () => {
    const { dist, kube } = await fixture();
    await dist.reconcile();
    assert.ok(kube.get(NS, "Deployment", `brain-${AGENT}`));
    // Mark the agent as a reaped ephemeral.
    const agent = dist.state.get("Agent", NS, AGENT);
    agent.spec.lifecycle = "ephemeral";
    agent.status.phase = "completed";
    await dist.state.save();
    await dist.reconcile();
    assert.equal(kube.get(NS, "Deployment", `brain-${AGENT}`), undefined, "brain Deployment should be cascaded away");
    assert.equal(kube.get(NS, "Service", `brain-${AGENT}`), undefined, "brain Service should be cascaded away");
});

test("controller writes status.phase back to resources (kubectl get agents shows phase)", async () => {
    const { dist } = await fixture();
    await dist.reconcile();
    const agent = dist.state.get("Agent", NS, AGENT);
    assert.equal(agent.status.phase, "active");
    assert.equal(agent.status.brainPod, `brain-${AGENT}`);
    const home = dist.state.get("Home", NS, HOME);
    assert.equal(home.status.phase, "ready");
    assert.equal(home.status.pvc, `home-${HOME}`);
});

test("controller reconcile is idempotent (re-running produces no duplicates)", async () => {
    const { dist, kube } = await fixture();
    await dist.reconcile();
    await dist.reconcile();
    await dist.reconcile();
    // One brain Deployment + one hands Deployment (from the auto-created Hands resource).
    const deps = await kube.list(NS, "Deployment");
    const brainDeps = deps.filter((d) => d.metadata.name.startsWith("brain-"));
    const handsDeps = deps.filter((d) => d.metadata.name.startsWith("hands-"));
    assert.equal(brainDeps.length, 1, "only one brain Deployment despite multiple reconciles");
    assert.equal(handsDeps.length, 1, "only one hands Deployment despite multiple reconciles");
    const svcs = await kube.list(NS, "Service");
    assert.equal(svcs.length, 2, "brain + hand services");
});

test("controller stamps hades labels on every owned object", async () => {
    const { dist, kube } = await fixture();
    await dist.reconcile();
    const brainDep = kube.get(NS, "Deployment", `brain-${AGENT}`);
    assert.equal(brainDep.metadata.labels["hades.dev/managed-by"], "hades-controller");
    assert.equal(brainDep.metadata.labels["hades.dev/kind"], "Agent");
    assert.equal(brainDep.metadata.labels["hades.dev/name"], AGENT);
});

test("controller emits reconciliation events", async () => {
    const { dist, events } = await fixture();
    await dist.reconcile();
    const sys = await events.list("system");
    assert.ok(sys.some((e) => e.type === "agent.reconciled" && e.payload.agent === AGENT));
    assert.ok(sys.some((e) => e.type === "home.reconciled" && e.payload.home === HOME));
});

test("controller reconciles a NetworkPolicy that isolates hands pods (capability boundary)", async () => {
    const { dist, kube } = await fixture();
    await dist.apply({ kind: "Agent", metadata: { namespace: NS, name: "jay" }, spec: { homeRef: "jay-home", defaultSession: "jay-default", desiredState: "active", brain: { mode: "test" } } });
    await dist.apply({ kind: "Home", metadata: { namespace: NS, name: "jay-home" }, spec: {} });
    await dist.reconcile();
    const netpol = kube.get(NS, "NetworkPolicy", "hands-jay-netpol");
    assert.ok(netpol, "hands NetworkPolicy should be ensured");
    assert.deepEqual(netpol.spec.policyTypes, ["Ingress", "Egress"]);
    // Ingress: only the brain pod for this agent may reach hands.
    const ingress = netpol.spec.ingress[0];
    assert.deepEqual(ingress.from[0].podSelector.matchLabels, { "hades.dev/agent": "jay", "hades.dev/role": "brain" });
    // Egress: default-deny (no model creds, no internet from hands).
    assert.equal(netpol.spec.egress.length, 0);
});

test("controller mounts model credentials as a Secret only into the brain pod", async () => {
    const { dist, kube } = await fixture();
    await dist.apply({ kind: "Agent", metadata: { namespace: NS, name: "magpie" }, spec: { homeRef: HOME, defaultSession: "magpie-default", desiredState: "active", brain: { mode: "pi-sdk", secretRef: "magpie-model-creds" } } });
    await dist.reconcile();
    const brainDep = kube.get(NS, "Deployment", "brain-magpie");
    assert.ok(brainDep.spec.template.spec.containers[0].envFrom?.some((e) => e.secretRef?.name === "magpie-model-creds"), "brain should mount the model-creds Secret");
    // Hands must NOT have the secret.
    const handsDep = kube.get(NS, "Deployment", "hands-magpie");
    assert.ok(!handsDep.spec.template.spec.containers[0].envFrom, "hands must not mount any Secret");
});

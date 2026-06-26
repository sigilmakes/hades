import test from "node:test";
import assert from "node:assert/strict";
import { buildBrain, buildHands, buildHomePvc, buildSchedule, egressForAgent, toCronExpression } from "../dist/controller/builders.js";

const NS = "build-test";

test("buildHomePvc creates a PVC with the cluster-default storage class", () => {
    const pvc = buildHomePvc({ kind: "Home", metadata: { namespace: NS, name: "atlas-home" }, spec: { size: "5Gi" } });
    assert.equal(pvc.kind, "PersistentVolumeClaim");
    assert.equal(pvc.metadata.name, "home-atlas-home");
    assert.equal(pvc.spec.resources.requests.storage, "5Gi");
    assert.equal(pvc.spec.storageClassName, undefined, "storageClassName unset → cluster default");
});

test("buildBrain creates a Deployment + Service with the brain SA and agent env", () => {
    const agent = { kind: "Agent", metadata: { namespace: NS, name: "atlas" }, spec: { brain: { mode: "pi-sdk", secretRef: "creds" } } };
    const { deployment, service } = buildBrain(agent, undefined);
    assert.equal(deployment.kind, "Deployment");
    assert.equal(deployment.metadata.name, "brain-atlas");
    assert.equal(deployment.spec.template.spec.serviceAccountName, "hades-brain");
    const env = Object.fromEntries(deployment.spec.template.spec.containers[0].env.map((e) => [e.name, e.value]));
    assert.equal(env.HADES_AGENT_NAME, "atlas");
    assert.equal(env.HADES_AGENT_NAMESPACE, NS);
    assert.ok(deployment.spec.template.spec.containers[0].envFrom?.some((e) => e.secretRef?.name === "creds"), "model creds mounted");
    assert.equal(service.spec.selector["hades.dev/agent"], "atlas");
});

test("buildHands creates a sleep-infinity sandbox with no SA token and the home PVC", () => {
    const hands = { kind: "Hands", metadata: { namespace: NS, name: "atlas-home-shell" }, spec: { agentRef: "atlas" } };
    const agent = { kind: "Agent", metadata: { namespace: NS, name: "atlas" }, spec: { homeRef: "atlas-home" } };
    const { deployment, networkPolicy } = buildHands(hands, agent, undefined, []);
    assert.equal(deployment.spec.template.spec.automountServiceAccountToken, false);
    assert.deepEqual(deployment.spec.template.spec.containers[0].command, ["sleep", "infinity"]);
    assert.equal(deployment.spec.template.spec.volumes[0].persistentVolumeClaim.claimName, "home-atlas-home");
    assert.deepEqual(networkPolicy.spec.policyTypes, ["Ingress", "Egress"]);
    assert.equal(networkPolicy.spec.egress.length, 0, "default-deny with empty egress");
});

test("egressForAgent projects networkEgress:restricted-web into DNS + HTTPS", () => {
    const grants = [
        { kind: "CapabilityGrant", spec: { subject: { kind: "Agent", name: "atlas" }, capabilities: ["networkEgress:restricted-web"] } },
    ];
    const egress = egressForAgent(grants, "atlas");
    assert.ok(egress.length >= 2);
    assert.ok(egress.some((e) => e.ports?.some((p) => p.port === 443)), "HTTPS");
    assert.ok(egress.some((e) => e.ports?.some((p) => p.port === 53)), "DNS");
});

test("egressForAgent is default-deny with no network grant", () => {
    const grants = [{ kind: "CapabilityGrant", spec: { subject: { kind: "Agent", name: "atlas" }, capabilities: ["spawnAgent"] } }];
    assert.equal(egressForAgent(grants, "atlas").length, 0);
});

test("toCronExpression converts intervals and passes cron through", () => {
    assert.equal(toCronExpression({ type: "interval", schedule: "30s" }), "*/30 * * * *");
    assert.equal(toCronExpression({ type: "interval", schedule: "5m" }), "*/5 * * * *");
    assert.equal(toCronExpression({ type: "interval", schedule: "2h" }), "0 */2 * * *");
    assert.equal(toCronExpression({ type: "cron", schedule: "0 0 * * *" }), "0 0 * * *");
    assert.throws(() => toCronExpression({ type: "interval", schedule: "5x" }), /Invalid interval/);
});

test("buildSchedule creates a CronJob that triggers hades say", () => {
    const schedule = { kind: "Schedule", metadata: { namespace: NS, name: "tick" }, spec: { agentRef: "atlas", prompt: "hello" } };
    const cron = buildSchedule(schedule, "*/5 * * * *", undefined);
    assert.equal(cron.kind, "CronJob");
    assert.equal(cron.metadata.name, "sched-tick");
    assert.equal(cron.spec.schedule, "*/5 * * * *");
    const cmd = cron.spec.jobTemplate.spec.template.spec.containers[0].command;
    assert.deepEqual(cmd, ["node", "dist/cli.js", "say", `${NS}/atlas`, "hello"]);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HandsPod } from "../dist/hands-pod/server.js";
import { BrainPod } from "../dist/brain-pod/server.js";
import { HttpBrainDriver } from "../dist/adapters/brain/HttpBrainDriver.js";
import { McpHandsClient } from "../dist/adapters/hands/McpHandsClient.js";
import { createDistributedRuntime } from "../dist/runtime/DistributedRuntime.js";
import { FakeKubeClient } from "../dist/adapters/kube/FakeKubeClient.js";

const NS = "milestone";
const AGENT = "wren";
const SESSION = "wren-default";
const HOME = "wren-home";
const agent = { kind: "Agent", metadata: { namespace: NS, name: AGENT }, spec: { displayName: "Wren" } };
const session = { kind: "Session", metadata: { namespace: NS, name: SESSION }, spec: {} };

async function startHandsPod(homeRoot) {
    const pod = new HandsPod({ homeRoot });
    await new Promise((resolve) => pod.listen(0, resolve));
    const port = pod.server.address().port;
    return { pod, url: `http://127.0.0.1:${port}` };
}

async function startBrainPod(handsUrl) {
    const hands = new McpHandsClient(handsUrl);
    const pod = new BrainPod({ mode: "test", hands });
    await new Promise((resolve) => pod.listen(0, resolve));
    const port = pod.server.address().port;
    return { pod, url: `http://127.0.0.1:${port}`, hands };
}

test("milestone: one agent end-to-end over HTTP — message in, tool call over MCP, reply out", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "hades-milestone-"));
    await mkdir(path.join(home, "vault"), { recursive: true });
    const { pod: handsPod, url: handsUrl } = await startHandsPod(home);
    const { pod: brainPod, url: brainUrl, hands } = await startBrainPod(handsUrl);
    try {
        // Drive the controller to reconcile an Agent manifest.
        const dir = await mkdtemp(path.join(tmpdir(), "hades-milestone-state-"));
        const kube = new FakeKubeClient();
        const dist = await (await createDistributedRuntime(dir, { kubeClient: kube })).init();
        await dist.apply({ kind: "Home", metadata: { namespace: NS, name: HOME }, spec: {} });
        await dist.apply({ kind: "Agent", metadata: { namespace: NS, name: AGENT }, spec: { homeRef: HOME, defaultSession: SESSION, desiredState: "active", brain: { mode: "test", secretRef: "wren-creds" } } });
        await dist.apply({ kind: "CapabilityGrant", metadata: { namespace: NS, name: "self" }, spec: { subject: { kind: "Agent", name: AGENT }, capabilities: ["createOwnSchedule"], constraints: { namespace: "own" } } });
        await dist.reconcile();
        // Controller reconciled native k8s objects.
        assert.ok(kube.get(NS, "Deployment", `brain-${AGENT}`), "controller ensured brain Deployment");
        assert.ok(kube.get(NS, "Deployment", `hands-${AGENT}`), "controller ensured hands Deployment");
        assert.ok(kube.get(NS, "PersistentVolumeClaim", `home-${HOME}`), "controller ensured home PVC");
        assert.ok(kube.get(NS, "NetworkPolicy", `hands-${AGENT}-netpol`), "controller ensured hands NetworkPolicy");

        // Now drive the brain pod directly (the parent->brain wire) with a tool call.
        const driver = new HttpBrainDriver(brainUrl);
        const writeReply = await driver.run({ agent, session, prompt: "!write vault/milestone.md <<<hello from distributed hades" });
        assert.match(writeReply, /wrote vault\/milestone.md/);
        assert.equal(await readFile(path.join(home, "vault", "milestone.md"), "utf8"), "hello from distributed hades");

        // Read back through the same distributed path.
        const readReply = await driver.run({ agent, session, prompt: "!read vault/milestone.md" });
        assert.equal(readReply, "hello from distributed hades");
        await hands.close();
    } finally {
        await brainPod.close();
        await handsPod.close();
    }
});

test("milestone: agent survives a brain pod restart (wake from durable home)", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "hades-milestone-restart-"));
    await mkdir(path.join(home, "vault"), { recursive: true });
    const { pod: handsPod, url: handsUrl } = await startHandsPod(home);
    let brain = await startBrainPod(handsUrl);
    try {
        const driver = new HttpBrainDriver(brain.url);
        await driver.run({ agent, session, prompt: "!write vault/persist.md <<<survives restart" });
        // Kill the brain pod (simulate crash). The agent is NOT the brain pod.
        await brain.pod.close();
        await brain.hands.close();
        // A new brain pod wakes; state persists on the home PVC (durable).
        brain = await startBrainPod(handsUrl);
        const driver2 = new HttpBrainDriver(brain.url);
        const readReply = await driver2.run({ agent, session, prompt: "!read vault/persist.md" });
        assert.equal(readReply, "survives restart", "new brain pod reads state persisted by the crashed one (home PVC durability)");
        await brain.hands.close();
    } finally {
        await brain.pod.close();
        await handsPod.close();
    }
});

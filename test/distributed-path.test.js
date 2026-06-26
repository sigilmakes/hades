import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HandsPod } from "../dist/hands-pod/server.js";
import { BrainPod } from "../dist/brain-pod/server.js";
import { HttpBrainDriver } from "../dist/adapters/brain/HttpBrainDriver.js";
import { McpHandsClient } from "../dist/adapters/hands/McpHandsClient.js";

const NS = "dist-test";
const AGENT = "magpie";
const SESSION = "magpie-default";
const agent = { kind: "Agent", metadata: { namespace: NS, name: AGENT }, spec: { displayName: "Magpie" } };
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

test("distributed path: brain pod routes tool calls to a hands pod over MCP", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "hades-dist-"));
    await mkdir(path.join(home, "vault"), { recursive: true });
    const { pod: handsPod, url: handsUrl } = await startHandsPod(home);
    const { pod: brainPod, url: brainUrl, hands } = await startBrainPod(handsUrl);
    try {
        const driver = new HttpBrainDriver(brainUrl);
        // write through brain pod -> (MCP) -> hands pod -> home PVC
        const writeReply = await driver.run({ agent, session, prompt: "!write vault/dist.md <<<from distributed hades" });
        assert.match(writeReply, /wrote vault\/dist.md/);
        assert.equal(await readFile(path.join(home, "vault", "dist.md"), "utf8"), "from distributed hades");
        // read back through the same distributed path
        const readReply = await driver.run({ agent, session, prompt: "!read vault/dist.md" });
        assert.equal(readReply, "from distributed hades");
        await hands.close();
    } finally {
        await brainPod.close();
        await handsPod.close();
    }
});

test("distributed path: confinement is enforced at the hands pod over MCP", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "hades-dist-"));
    const { pod: handsPod, url: handsUrl } = await startHandsPod(home);
    const { pod: brainPod, url: brainUrl, hands } = await startBrainPod(handsUrl);
    try {
        const driver = new HttpBrainDriver(brainUrl);
        // path escape -> hands pod rejects over MCP -> brain pod surfaces as error
        await assert.rejects(
            driver.run({ agent, session, prompt: "!read ../etc/passwd" }),
            /brain pod error:|Path escapes home|Absolute paths/,
        );
        await hands.close();
    } finally {
        await brainPod.close();
        await handsPod.close();
    }
});

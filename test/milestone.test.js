import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BrainPod } from "../dist/brain-pod/server.js";
import { HttpBrainDriver } from "../dist/adapters/brain/HttpBrainDriver.js";
import { PodHandsBackend } from "../dist/adapters/hands/PodHandsBackend.js";

/**
 * Milestone: the real brain→hands path — brain pod execs into a hands pod via
 * the k8s API. No MCP server, no HTTP hands Service. The brain pod's
 * PodHandsBackend execs cat/sh into the "hands pod" (a fake exec-capable kube
 * client backed by the local filesystem, standing in for the real pod).
 *
 * This proves the wiring that #11 closed: the controller's HADES_AGENT_NAME/
 * HADES_AGENT_NAMESPACE env → brain pod → PodHandsBackend → exec → home.
 */

const NS = "milestone";
const AGENT = "atlas";

/** A fake kube client that execs against the local filesystem (stands in for a pod). */
class LocalExecKube {
    constructor(homeRoot) {
        this.homeRoot = homeRoot;
        this.calls = [];
        this.ensure = async () => "";
        this.delete = async () => false;
        this.list = async () => [];
        this.healthz = async () => true;
    }

    async exec(_ns, _pod, _container, command, stdin) {
        this.calls.push({ command, stdin });
        const joined = command.join(" ");
        // cat <path> — read the file from the local home root.
        if (command[0] === "cat") {
            const target = command[1];
            const rel = target.replace(/^\/home\/agent\//, "");
            try {
                const content = await readFile(path.join(this.homeRoot, rel), "utf8");
                return { code: 0, stdout: content, stderr: "" };
            } catch (e) {
                return { code: 1, stdout: "", stderr: e.message };
            }
        }
        // mkdir -p <dir>
        if (joined.startsWith("mkdir -p")) {
            const dir = command[command.indexOf("-p") + 1].replace(/^\/home\/agent\//, "");
            await mkdir(path.join(this.homeRoot, dir), { recursive: true });
            return { code: 0, stdout: "", stderr: "" };
        }
        // sh -c 'cat > <path>' — write via stdin.
        if (command[0] === "sh" && command[1] === "-c" && command[2].startsWith("cat >")) {
            const match = command[2].match(/cat > '([^']+)'/);
            const target = match[1].replace(/^\/home\/agent\//, "");
            await mkdir(path.dirname(path.join(this.homeRoot, target)), { recursive: true });
            await writeFile(path.join(this.homeRoot, target), stdin ?? "", "utf8");
            return { code: 0, stdout: "", stderr: "" };
        }
        // sh -c 'cd <dir> && <cmd>' — exec
        if (command[0] === "sh" && command[1] === "-c") {
            return { code: 0, stdout: `ran: ${command[2]}`, stderr: "" };
        }
        return { code: 1, stdout: "", stderr: `unexpected command: ${joined}` };
    }
}

test("milestone: brain pod execs into the hands pod via PodHandsBackend — write then read", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "hades-milestone-"));
    await mkdir(path.join(home, "vault"), { recursive: true });
    const kube = new LocalExecKube(home);
    // The brain pod's PodHandsBackend: execs into hands-atlas in namespace milestone.
    const hands = new PodHandsBackend({ homeRoot: home, kubeClient: kube, namespace: NS, pod: `hands-${AGENT}` });
    const pod = new BrainPod({ mode: "test", hands });
    await new Promise((resolve) => pod.listen(0, resolve));
    const port = pod.server.address().port;
    try {
        const driver = new HttpBrainDriver(`http://127.0.0.1:${port}`);
        const agent = { kind: "Agent", metadata: { namespace: NS, name: AGENT }, spec: { displayName: "Atlas" } };
        const session = { kind: "Session", metadata: { namespace: NS, name: `${AGENT}-default` }, spec: {} };

        // write through brain pod -> exec into hands pod -> home
        const writeReply = await driver.run({ agent, session, prompt: "!write vault/note.md <<<hello from brain pod" });
        assert.match(writeReply, /wrote vault\/note.md/);
        assert.equal(await readFile(path.join(home, "vault", "note.md"), "utf8"), "hello from brain pod");

        // read back through the same exec path
        const readReply = await driver.run({ agent, session, prompt: "!read vault/note.md" });
        assert.equal(readReply, "hello from brain pod");

        // exec reaches the hands pod
        const execReply = await driver.run({ agent, session, prompt: "!exec echo milestone" });
        assert.match(execReply, /ran:|milestone/);
    } finally {
        await pod.close();
    }
});

test("milestone: PodHandsBackend rejects path escapes before any exec (confinement holds over the wire)", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "hades-milestone-"));
    const kube = new LocalExecKube(home);
    const hands = new PodHandsBackend({ homeRoot: home, kubeClient: kube, namespace: NS, pod: `hands-${AGENT}` });
    const pod = new BrainPod({ mode: "test", hands });
    await new Promise((resolve) => pod.listen(0, resolve));
    const port = pod.server.address().port;
    try {
        const driver = new HttpBrainDriver(`http://127.0.0.1:${port}`);
        const agent = { kind: "Agent", metadata: { namespace: NS, name: AGENT }, spec: {} };
        const session = { kind: "Session", metadata: { namespace: NS, name: `${AGENT}-default` }, spec: {} };
        await assert.rejects(
            (async () => driver.run({ agent, session, prompt: "!read ../etc/passwd" }))(),
            /brain pod error:|Path escapes home|Absolute paths/,
        );
        // No exec issued for the rejected path.
        assert.equal(kube.calls.filter((c) => c.command[0] === "cat").length, 0);
    } finally {
        await pod.close();
    }
});

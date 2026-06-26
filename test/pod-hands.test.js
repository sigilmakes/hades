import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PodHandsBackend } from "../dist/adapters/hands/PodHandsBackend.js";

/** A fake kube client that records exec calls and returns canned results. */
class RecordingKubeClient {
    constructor(handler) {
        this.calls = [];
        this.handler = handler;
        this.ensure = async () => "";
        this.delete = async () => false;
        this.list = async () => [];
        this.healthz = async () => true;
    }

    async exec(_ns, _pod, _container, command, stdin) {
        this.calls.push({ command, stdin });
        return this.handler(command);
    }
}

const HOME = "/home/sigil/hades-test-home";

test("PodHandsBackend read execs cat into the pod at the mounted home path", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "hades-pod-"));
    const kube = new RecordingKubeClient((cmd) => {
        if (cmd[0] === "cat") return { code: 0, stdout: "file contents", stderr: "" };
        return { code: 1, stdout: "", stderr: "unexpected" };
    });
    const hands = new PodHandsBackend({ homeRoot: home, kubeClient: kube, namespace: "ns", pod: "hands-atlas" });
    const text = await hands.read("vault/note.md");
    assert.equal(text, "file contents");
    assert.deepEqual(kube.calls[0].command, ["cat", "/home/agent/vault/note.md"]);
});

test("PodHandsBackend write mkdirs the parent and writes via stdin", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "hades-pod-"));
    const kube = new RecordingKubeClient((cmd) => {
        const joined = cmd.join(" ");
        if (joined.startsWith("mkdir -p")) return { code: 0, stdout: "", stderr: "" };
        if (joined.startsWith("sh -c cat >")) return { code: 0, stdout: "", stderr: "" };
        return { code: 1, stdout: "", stderr: "unexpected" };
    });
    const hands = new PodHandsBackend({ homeRoot: home, kubeClient: kube, namespace: "ns", pod: "hands-atlas" });
    const result = await hands.write("vault/deep/note.md", "hello");
    assert.equal(result.bytes, 5);
    // mkdir the parent
    assert.ok(kube.calls.some((c) => c.command.join(" ").includes("mkdir -p") && c.command.join(" ").includes("vault/deep")));
    // write via sh -c 'cat > path' with stdin
    const writeCall = kube.calls.find((c) => c.command[0] === "sh" && c.command[1] === "-c");
    assert.ok(writeCall, "write uses sh -c");
    assert.match(writeCall.command[2], /cat > '\/home\/agent\/vault\/deep\/note.md'/);
    assert.equal(writeCall.stdin, "hello");
});

test("PodHandsBackend exec cds into the workdir and runs the command", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "hades-pod-"));
    const kube = new RecordingKubeClient((cmd) => {
        const joined = cmd.join(" ");
        if (joined.includes("cd ") && joined.includes("echo hi")) return { code: 0, stdout: "hi\n", stderr: "" };
        return { code: 1, stdout: "", stderr: "unexpected" };
    });
    const hands = new PodHandsBackend({ homeRoot: home, kubeClient: kube, namespace: "ns", pod: "hands-atlas" });
    const result = await hands.exec({ command: "echo hi", cwd: "projects" });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "hi\n");
    assert.match(kube.calls[0].command[2], /cd '\/home\/agent\/projects'/);
});

test("PodHandsBackend rejects path escapes before any exec (home policy still applies)", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "hades-pod-"));
    const kube = new RecordingKubeClient(() => ({ code: 0, stdout: "", stderr: "" }));
    const hands = new PodHandsBackend({ homeRoot: home, kubeClient: kube, namespace: "ns", pod: "hands-atlas" });
    await assert.rejects(hands.read("../etc/passwd"), /Path escapes home|Absolute paths/);
    assert.equal(kube.calls.length, 0, "no exec issued for a rejected path");
});

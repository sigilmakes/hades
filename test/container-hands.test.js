import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { ContainerHands, PERMISSIVE_CONTAINER_PROFILE } from "../dist/adapters/hands/ContainerHands.js";
import { parseConfinedExecCommand } from "../dist/adapters/hands/ConfinedCommandParser.js";

const dockerAvailable = (() => {
    try { execSync("docker info", { stdio: "ignore" }); return true; } catch { return false; }
})();

test("permissive container profile allows interpreters and shell metacharacters", () => {
    assert.equal(PERMISSIVE_CONTAINER_PROFILE.id, "permissive-container");
    assert.equal(PERMISSIVE_CONTAINER_PROFILE.allowShellMetachars, true);
    assert.equal(PERMISSIVE_CONTAINER_PROFILE.requireHomeRelativeExecutable, false);
    assert.equal(PERMISSIVE_CONTAINER_PROFILE.deniedInterpreters.size, 0);
    // The permissive profile lets bash/python/node run — under real container isolation.
    assert.deepEqual(parseConfinedExecCommand("bash -lc 'echo hi'", PERMISSIVE_CONTAINER_PROFILE), ["bash", "-lc", "echo hi"]);
});

test("container hands read/write against the home without docker", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "hades-container-"));
    await mkdir(path.join(home, "vault"), { recursive: true });
    const hands = new ContainerHands({ homeRoot: home });
    const w = await hands.write("vault/note.md", "container-backed");
    assert.equal(w.bytes, "container-backed".length);
    const r = await hands.read("vault/note.md");
    assert.equal(r, "container-backed");
});

test("container hands reject path escapes (home policy still applies)", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "hades-container-"));
    const hands = new ContainerHands({ homeRoot: home });
    await assert.rejects(hands.read("../etc/passwd"), /Path escapes home|Absolute paths/);
    await assert.rejects(hands.write("../escape", "bad"), /Path escapes home|Absolute paths/);
});

test("container hands exec runs a command in a disposable container", { skip: !dockerAvailable }, async () => {
    const home = await mkdtemp(path.join(tmpdir(), "hades-container-"));
    await mkdir(path.join(home, "bin"), { recursive: true });
    const hands = new ContainerHands({ homeRoot: home });
    // bash is ALLOWED here — the container is the isolation boundary.
    const result = await hands.exec({ command: "echo container-exec-ok" });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /container-exec-ok/);
});

test("container hands exec can run an interpreter the confined profile denies", { skip: !dockerAvailable }, async () => {
    const home = await mkdtemp(path.join(tmpdir(), "hades-container-"));
    await mkdir(path.join(home, "scripts"), { recursive: true });
    await writeFile(path.join(home, "scripts", "hi.js"), "console.log('node in container')\n", "utf8");
    const hands = new ContainerHands({ homeRoot: home }); // node:24-slim image
    const result = await hands.exec({ command: "node scripts/hi.js", cwd: "." });
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /node in container/, `stdout: ${result.stdout}, stderr: ${result.stderr}`);
});

test("container hands exec writes to the mounted home and the write is visible outside", { skip: !dockerAvailable }, async () => {
    const home = await mkdtemp(path.join(tmpdir(), "hades-container-"));
    await mkdir(path.join(home, "vault"), { recursive: true });
    const hands = new ContainerHands({ homeRoot: home });
    await hands.exec({ command: "echo from-container > vault/wrote.md" });
    // The container mounted the host home read-write, so the file is visible on the host.
    assert.equal(await readFile(path.join(home, "vault", "wrote.md"), "utf8").catch(() => ""), "from-container\n");
});

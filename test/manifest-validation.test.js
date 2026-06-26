import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime } from "../dist/runtime/HadesRuntime.js";
import { validateResource, ValidationError } from "../dist/domain/validate.js";

async function runtime() {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-val-"));
    return (await createRuntime(dir)).init();
}

test("validateResource rejects an unknown kind", () => {
    assert.throws(
        () => validateResource({ kind: "Widget", metadata: { name: "foo" } }),
        /unknown kind 'Widget'/,
    );
});

test("validateResource rejects a missing name", () => {
    assert.throws(
        () => validateResource({ kind: "Agent", metadata: {} }),
        /metadata\.name: missing name/,
    );
});

test("validateResource rejects an uppercase/non-DNS name", () => {
    assert.throws(
        () => validateResource({ kind: "Agent", metadata: { name: "Bad_Name" } }),
        /must be a lowercase DNS label/,
    );
});

test("validateResource rejects a bad desiredState on an Agent", () => {
    assert.throws(
        () => validateResource({ kind: "Agent", metadata: { name: "a" }, spec: { desiredState: "vibrant" } }),
        /desiredState 'vibrant' must be active\|idle\|stopped/,
    );
});

test("validateResource rejects a Schedule missing its type", () => {
    assert.throws(
        () => validateResource({ kind: "Schedule", metadata: { name: "s" }, spec: { schedule: "0 7 * * *" } }),
        /spec\.type: missing schedule type/,
    );
});

test("validateResource rejects a CapabilityGrant without capabilities", () => {
    assert.throws(
        () => validateResource({ kind: "CapabilityGrant", metadata: { name: "g" }, spec: { subject: { kind: "Agent", name: "a" } } }),
        /capabilities must be a non-empty array/,
    );
});

test("validateResource accepts a well-formed Agent", () => {
    assert.doesNotThrow(() =>
        validateResource({ kind: "Agent", metadata: { name: "atlas", namespace: "agent-atlas" }, spec: { desiredState: "active", brain: { mode: "test" } } }),
    );
});

test("ValidationError carries the offending field", () => {
    try {
        validateResource({ kind: "Agent", metadata: { name: "x" }, spec: { desiredState: "nope" } });
        assert.fail("should have thrown");
    } catch (error) {
        assert.ok(error instanceof ValidationError);
        assert.equal(error.field, "spec.desiredState");
    }
});

test("runtime.apply rejects an invalid resource before persisting", async () => {
    const rt = await runtime();
    await assert.rejects(
        rt.apply({ kind: "Agent", metadata: { name: "UPPER" } }),
        /must be a lowercase DNS label/,
    );
    // Nothing was stored.
    assert.equal(rt.state.list("Agent").length, 0);
});

test("hades apply fails fast on a manifest with one bad document", async () => {
    const { spawnSync } = await import("node:child_process");
    const dir = await mkdtemp(path.join(tmpdir(), "hades-val-"));
    const file = path.join(dir, "bad.yaml");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, `apiVersion: hades.dev/v1alpha1\nkind: Agent\nmetadata:\n  name: Bad_Name\n`);
    const result = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "up", file], {
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, HADES_DATA_DIR: path.join(dir, ".hades") },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /must be a lowercase DNS label/);
});

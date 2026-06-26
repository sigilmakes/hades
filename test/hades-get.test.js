import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import path from "node:path";

function mkdtempSync2() {
    return spawnSync("mktemp", ["-d"], { encoding: "utf8" }).stdout.trim();
}

function hades(cwd, ...args) {
    return spawnSync(process.execPath, [path.resolve("dist/cli.js"), ...args], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, HADES_DATA_DIR: path.join(cwd, ".hades") },
    });
}

test("hades get agents prints a kubectl-style table with headers", () => {
    const cwd = mkdtempSync2();
    hades(cwd, "up", path.resolve("examples/atlas/alpha.json"));
    const result = hades(cwd, "get", "agents");
    assert.equal(result.status, 0);
    const lines = result.stdout.trim().split("\n");
    assert.match(lines[0], /NAME\s+NAMESPACE\s+PHASE\s+DETAIL/);
    assert.ok(lines.some((l) => l.startsWith("atlas")));
    assert.ok(lines.some((l) => l.startsWith("provisioner")));
});

test("hades get <kind> <name> prints full JSON for one resource", () => {
    const cwd = mkdtempSync2();
    hades(cwd, "up", path.resolve("examples/atlas/alpha.json"));
    const result = hades(cwd, "get", "agent", "atlas");
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.kind, "Agent");
    assert.equal(parsed.metadata.name, "atlas");
});

test("hades get supports --namespace filtering", () => {
    const cwd = mkdtempSync2();
    hades(cwd, "up", path.resolve("examples/atlas/alpha.json"));
    const result = hades(cwd, "get", "agents", "--namespace", "agent-atlas");
    assert.equal(result.status, 0);
    const lines = result.stdout.trim().split("\n").slice(1);
    assert.ok(lines.every((l) => l.includes("agent-atlas")), "all rows in the namespace");
    assert.ok(lines.some((l) => l.startsWith("atlas")));
    assert.ok(!lines.some((l) => l.startsWith("provisioner")), "system agents filtered out");
});

test("hades get with an unknown kind errors clearly", () => {
    const cwd = mkdtempSync2();
    hades(cwd, "up", path.resolve("examples/atlas/alpha.json"));
    const result = hades(cwd, "get", "widgets");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown kind widgets/);
});

test("hades get schedules shows the cron expression in DETAIL", () => {
    const cwd = mkdtempSync2();
    hades(cwd, "up", path.resolve("examples/atlas/alpha.json"));
    const result = hades(cwd, "get", "schedules");
    assert.equal(result.status, 0);
    const lines = result.stdout.trim().split("\n").slice(1);
    assert.ok(lines.some((l) => l.includes("morning-ritual") && l.includes("cron: 0 7 * * *")));
});

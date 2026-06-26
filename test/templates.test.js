import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function hades(cwd, ...args) {
    return spawnSync(process.execPath, [path.resolve("dist/cli.js"), ...args], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, HADES_DATA_DIR: path.join(cwd, ".hades") },
    });
}

test("hades new discord-bot creates Home+Agent+Listener+Grant with substitutions", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "hades-tmpl-"));
    const result = hades(cwd, "new", "discord-bot", "mybot", "--namespace", "agent-mybot", "--set", "token-secret=mybot-token");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /created mybot from template discord-bot \(4 resources in agent-mybot\)/);
    const state = hades(cwd, "state").stdout;
    assert.match(state, /"name": "mybot"/);
    assert.match(state, /"platform": "discord"/);
    assert.match(state, /"secretRef": "mybot-token"/);
});

test("hades new cron-worker applies a schedule with the substituted prompt", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "hades-tmpl-"));
    const result = hades(cwd, "new", "cron-worker", "nightly", "--namespace", "agent-nightly", "--set", "prompt=Summarize the day");
    assert.equal(result.status, 0, result.stderr);
    const schedules = hades(cwd, "get", "schedules").stdout;
    assert.match(schedules, /nightly-tick/);
    assert.match(schedules, /cron: 0 9 \* \* \*/);
    const state = hades(cwd, "state").stdout;
    assert.match(state, /"prompt": "Summarize the day"/);
});

test("hades new with an unknown template errors clearly", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "hades-tmpl-"));
    const result = hades(cwd, "new", "nonexistent", "x");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /template 'nonexistent' not found/);
});

test("hades new requires a name", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "hades-tmpl-"));
    const result = hades(cwd, "new", "discord-bot");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /requires a template and name/);
});

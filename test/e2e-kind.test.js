import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

// The full kind e2e (#43) runs in CI (.github/workflows/e2e.yml) and is too
// heavy for the unit suite. These guards ensure the e2e path doesn't bit-rot:
// the script exists, is executable, has valid shell syntax, and the CI
// workflow references it. The actual cluster bring-up is exercised in CI.

test("the e2e repro script exists and is executable", () => {
    const script = path.resolve("scripts/e2e-kind.sh");
    assert.ok(existsSync(script), "scripts/e2e-kind.sh exists");
    const st = statSync(script);
    assert.ok(st.mode & 0o111, "scripts/e2e-kind.sh is executable");
});

test("the e2e repro script has valid bash syntax", () => {
    const script = path.resolve("scripts/e2e-kind.sh");
    const res = spawnSync("bash", ["-n", script], { encoding: "utf8" });
    assert.equal(res.status, 0, `bash -n failed: ${res.stderr}`);
});

test("the e2e CI workflow exists and references the repro script", () => {
    const workflow = path.resolve(".github/workflows/e2e.yml");
    assert.ok(existsSync(workflow), ".github/workflows/e2e.yml exists");
    const content = readFileSync(workflow, "utf8");
    assert.match(content, /scripts\/e2e-kind\.sh/, "workflow runs the e2e script");
    assert.match(content, /helm\/kind-action/, "workflow brings up kind");
    assert.match(content, /setup-helm/, "workflow installs helm");
});

test("the e2e workflow is valid YAML", () => {
    const content = readFileSync(".github/workflows/e2e.yml", "utf8");
    const doc = yaml.load(content);
    assert.equal(doc.name, "E2E (kind)");
    assert.ok(doc.jobs["kind-e2e"], "has the kind-e2e job");
});

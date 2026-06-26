import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const HELM = process.env.HELM ?? "helm";

function helmAvailable() {
  const cmd = spawnSync(HELM, ["version"], { encoding: "utf8" });
  if (!cmd.error) return true;
  // Fall back to nix; if that's absent too, skip (CI without nix).
  const nix = spawnSync("nix", ["--version"], { encoding: "utf8" });
  return !nix.error;
}

const HAS_HELM = helmAvailable();

function helm(...args) {
  // Use nix to provide helm if it isn't on PATH (NixOS dev host).
  const cmd = spawnSync(HELM, args, { encoding: "utf8" });
  if (cmd.error && cmd.error.code === "ENOENT") {
    return spawnSync("nix", ["shell", "nixpkgs#kubernetes-helm", "-c", "helm", ...args], { encoding: "utf8" });
  }
  return cmd;
}

function render() {
  const res = helm("template", "hades", path.resolve("charts/hades"), "--namespace", "hades-system");
  if (res.status !== 0) throw new Error(res.stderr || res.stdout);
  return res.stdout;
}

// Split a multi-doc YAML stream into docs (skipping the empty leading doc).
function docs(yaml) {
  return yaml.split("\n---\n").map((d) => d.trim()).filter(Boolean);
}

test("helm template renders without error", { skip: !HAS_HELM }, () => {
  const out = render();
  assert.ok(out.length > 0);
});

test("helm chart renders the core control-plane resources", { skip: !HAS_HELM }, () => {
  const out = render();
  const kinds = new Set(docs(out).map((d) => d.match(/^kind: (\S+)/m)?.[1]));
  for (const expected of ["Namespace", "ServiceAccount", "ClusterRole", "ClusterRoleBinding", "PersistentVolumeClaim", "Deployment", "Service"]) {
    assert.ok(kinds.has(expected), `chart renders a ${expected}`);
  }
});

test("helm chart renders all Hades CRDs", { skip: !HAS_HELM }, () => {
  const out = render();
  const crdCount = (out.match(/^kind: CustomResourceDefinition$/gm) || []).length;
  assert.ok(crdCount >= 15, `renders all 15 CRDs (got ${crdCount})`);
});

// Guard against the recurring bug where a new Hades kind is added to the
// controller's HADES_KINDS list but the controller ClusterRole isn't updated
// to grant access to it — reconcile then 403s against a live cluster. The
// reconciled kinds are mirrored from src/controller/KubeController.ts.
test("controller ClusterRole grants access to every reconciled Hades kind", { skip: !HAS_HELM }, () => {
  const out = render();
  const controllerRole = docs(out).find((d) => /^kind: ClusterRole$/m.test(d) && d.includes("name: hades-controller"));
  assert.ok(controllerRole, "controller ClusterRole rendered");
  const hadesRule = controllerRole.match(/apiGroups: \["hades\.dev"\][\s\S]*?verbs:/);
  assert.ok(hadesRule, "hades.dev rule present");
  const rule = hadesRule[0];
  for (const plural of ["agents", "hands", "listeners", "schedules", "connectors", "handsimages", "skills", "namespacequotas"]) {
    assert.ok(rule.includes(plural), `controller may reconcile ${plural}`);
  }
});

test("helm values override the image and storage size", { skip: !HAS_HELM }, () => {
  const res = helm("template", "hades", path.resolve("charts/hades"), "--namespace", "hades-system",
    "--set", "image.repository=myreg/hades-api", "--set", "image.tag=v1.2.3", "--set", "api.storage.size=10Gi");
  if (res.status !== 0) throw new Error(res.stderr);
  assert.match(res.stdout, /image: "myreg\/hades-api:v1\.2\.3"/);
  assert.match(res.stdout, /storage: 10Gi/);
});

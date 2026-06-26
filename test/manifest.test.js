import test from "node:test";
import assert from "node:assert/strict";
import { parseDocuments } from "../dist/adapters/manifest.js";

test("parses a multi-document YAML manifest", () => {
    const raw = `
apiVersion: hades.dev/v1alpha1
kind: Home
metadata:
  name: atlas-home
  namespace: agent-atlas
---
apiVersion: hades.dev/v1alpha1
kind: Agent
metadata:
  name: atlas
  namespace: agent-atlas
`;
    const docs = parseDocuments(raw);
    assert.equal(docs.length, 2);
    assert.equal(docs[0].kind, "Home");
    assert.equal(docs[1].kind, "Agent");
});

test("parses arrays-of-objects (the hand-rolled parser broke on these)", () => {
    const raw = `
kind: Home
spec:
  files:
    - path: vault/a.md
      content: alpha
    - path: vault/b.md
      content: beta
`;
    const [doc] = parseDocuments(raw);
    assert.equal(doc.spec.files.length, 2);
    assert.equal(doc.spec.files[0].path, "vault/a.md");
    assert.equal(doc.spec.files[1].content, "beta");
});

test("parses block scalars (multi-line content)", () => {
    const raw = `
kind: Home
spec:
  files:
    - path: README.md
      content: |
        # Title

        Body text
        More text
`;
    const [doc] = parseDocuments(raw);
    assert.match(doc.spec.files[0].content, /# Title\n\nBody text\nMore text\n/);
});

test("parses quoted strings with colons", () => {
    const raw = `
kind: Home
spec:
  note: "quoted: with colon"
`;
    const [doc] = parseDocuments(raw);
    assert.equal(doc.spec.note, "quoted: with colon");
});

test("accepts JSON (a subset of YAML)", () => {
    const raw = `{"kind":"Agent","metadata":{"name":"atlas"},"spec":{"brain":{"mode":"test"}}}`;
    const [doc] = parseDocuments(raw);
    assert.equal(doc.kind, "Agent");
    assert.equal(doc.spec.brain.mode, "test");
});

test("drops empty documents (leading/trailing ---)", () => {
    const raw = `---
kind: Agent
metadata:
  name: a
---
kind: Agent
metadata:
  name: b
---
`;
    const docs = parseDocuments(raw);
    assert.equal(docs.length, 2);
    assert.equal(docs[0].metadata.name, "a");
    assert.equal(docs[1].metadata.name, "b");
});

test("the atlas example manifest parses fully", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const raw = await readFile(path.resolve("examples/atlas/alpha.json"), "utf8");
    const docs = parseDocuments(raw);
    assert.ok(docs.length >= 5, "atlas has agentclass, agent, home, listeners, schedules, grant");
    const agent = docs.find((d) => d.kind === "Agent");
    assert.equal(agent.metadata.name, "atlas");
    const home = docs.find((d) => d.kind === "Home");
    assert.ok(home.spec.files.length >= 2, "home has seeded files");
});

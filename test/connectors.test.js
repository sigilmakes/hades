import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime } from "../dist/runtime/HadesRuntime.js";
import { FakeKubeClient } from "../dist/adapters/kube/FakeKubeClient.js";
import { ConnectorToolRegistrar, connectorsFromEnv } from "../dist/adapters/brain/ConnectorToolRegistrar.js";

const NS = "agent-atlas";
const AGENT = "atlas";
const HOME = "atlas-home";
const SESSION = "atlas-default";

async function fixture() {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-conn-"));
    const kube = new FakeKubeClient();
    const rt = await (await createRuntime(dir, { kubeClient: kube })).init();
    await rt.apply({ kind: "Home", metadata: { namespace: NS, name: HOME }, spec: {} });
    await rt.apply({ kind: "Agent", metadata: { namespace: NS, name: AGENT }, spec: { homeRef: HOME, defaultSession: SESSION, desiredState: "active", brain: { mode: "test" } } });
    await rt.apply({ kind: "CapabilityGrant", metadata: { namespace: NS, name: "g" }, spec: { subject: { kind: "Agent", name: AGENT }, capabilities: ["attachConnector", "networkEgress:restricted-web"], constraints: { namespace: "own" } } });
    return { dir, rt, kube };
}

test("controller reconciles a Connector into an egress NetworkPolicy", async () => {
    const { rt, kube } = await fixture();
    await rt.apply({ kind: "Connector", metadata: { namespace: NS, name: "github" }, spec: { agentRef: AGENT, endpoint: "https://api.github.com", egress: "restricted-web" } });
    await rt.reconcile();
    const policy = await kube.get(NS, "NetworkPolicy", "connector-github");
    assert.ok(policy, "connector NetworkPolicy ensured");
    assert.equal(policy.spec.policyTypes[0], "Egress");
    assert.equal(policy.spec.podSelector.matchLabels["hades.dev/agent"], AGENT);
    const connector = rt.state.get("Connector", NS, "github");
    assert.equal(connector.status.phase, "ready");
    assert.equal(connector.status.reachable, true);
});

test("a Connector with egress:none ensures no NetworkPolicy", async () => {
    const { rt, kube } = await fixture();
    await rt.apply({ kind: "Connector", metadata: { namespace: NS, name: "local" }, spec: { agentRef: AGENT, endpoint: "http://local-svc:8080", egress: "none" } });
    await rt.reconcile();
    const policy = await kube.get(NS, "NetworkPolicy", "connector-local");
    assert.equal(policy, undefined, "no egress policy for a none connector");
    const connector = rt.state.get("Connector", NS, "local");
    assert.equal(connector.status.reachable, false);
});

test("the brain pod receives its connectors as HADES_CONNECTORS env", async () => {
    const { rt, kube } = await fixture();
    await rt.apply({ kind: "Connector", metadata: { namespace: NS, name: "github" }, spec: { agentRef: AGENT, endpoint: "https://api.github.com", secretRef: "gh-token", egress: "restricted-web" } });
    await rt.apply({ kind: "Connector", metadata: { namespace: NS, name: "slack" }, spec: { agentRef: AGENT, endpoint: "https://slack.com/api", egress: "restricted-web" } });
    await rt.reconcile();
    const brainDep = await kube.get(NS, "Deployment", `brain-${AGENT}`);
    const env = brainDep.spec.template.spec.containers[0].env;
    const connectorsEnv = env.find((e) => e.name === "HADES_CONNECTORS");
    assert.ok(connectorsEnv, "brain pod has HADES_CONNECTORS env");
    const manifest = JSON.parse(connectorsEnv.value);
    assert.equal(manifest.length, 2);
    assert.ok(manifest.some((c) => c.name === "github" && c.endpoint === "https://api.github.com" && c.secretRef === "gh-token"));
});

test("attachConnector is capability-gated", async () => {
    const { rt } = await fixture();
    // Works with the grant.
    await rt.connectors.attach({ kind: "Agent", name: AGENT, namespace: NS }, { name: "ok", endpoint: "https://example.com" });
    assert.ok(rt.state.get("Connector", NS, "ok"));
    // Denied without the capability: a different agent with no grant.
    await assert.rejects(
        rt.connectors.attach({ kind: "Agent", name: "stranger", namespace: NS }, { name: "nope", endpoint: "https://example.com" }),
        /Capability denied/,
    );
});

test("connectorsFromEnv parses the injected manifest", () => {
    const env = { HADES_CONNECTORS: JSON.stringify([{ name: "x", endpoint: "https://x", egress: "restricted-web" }]) };
    const cs = connectorsFromEnv(env);
    assert.equal(cs.length, 1);
    assert.equal(cs[0].name, "x");
    assert.deepEqual(connectorsFromEnv({}), []);
    assert.deepEqual(connectorsFromEnv({ HADES_CONNECTORS: "not json" }), []);
});

test("ConnectorToolRegistrar calls the deployed endpoint over HTTP", async () => {
    // A fake fetch that records the call.
    let lastUrl = "";
    let lastHeaders = {};
    const fakeFetch = async (url, init) => {
        lastUrl = url;
        lastHeaders = init?.headers ?? {};
        return new Response("hello from connector", { status: 200, statusText: "OK" });
    };
    // Minimal policy that always allows + a secret resolver returning a token.
    const policy = { can: () => ({ allowed: true }), assert: () => ({ allowed: true }) };
    const secrets = { get: async () => ({ authorization: "Bearer tok" }) };
    const Type = { Object: (s) => s, String: () => ({}), Optional: (v) => v };
    const defineTool = (def) => def;
    const tools = {};
    const api = { registerTool: (t) => { tools[t.name] = t; } };
    const registrar = new ConnectorToolRegistrar(
        { kind: "Agent", name: "a", namespace: "ns" }, policy, secrets, defineTool, Type,
        [{ name: "github", endpoint: "https://api.github.com/repos", secretRef: "gh", egress: "restricted-web" }],
        fakeFetch,
    );
    registrar.register(api);
    const tool = tools["hades_call_github"];
    assert.ok(tool, "registered hades_call_github tool");
    const result = await tool.execute("id", { path: "/foo", method: "GET" });
    assert.match(result.content[0].text, /200 OK\nhello from connector/);
    assert.equal(lastUrl, "https://api.github.com/repos/foo");
    assert.equal(lastHeaders.authorization, "Bearer tok");
});

test("hands pod runs as a non-root user by default (rootless)", async () => {
    const { rt, kube } = await fixture();
    await rt.reconcile();
    const handsDep = await kube.get(NS, "Deployment", `hands-${AGENT}`);
    const podSpec = handsDep.spec.template.spec;
    const container = podSpec.containers[0];
    assert.equal(container.securityContext.runAsNonRoot, true, "non-root by default");
    assert.equal(container.securityContext.runAsUser, 1000, "runs as uid 1000");
    assert.equal(podSpec.securityContext.fsGroup, 1000, "home PVC owned by fsGroup 1000");
    assert.equal(podSpec.automountServiceAccountToken, false, "no k8s API token");
});

test("a hands pod with userNamespace:true gets a rootless fake root (hostUsers:false)", async () => {
    const { rt, kube } = await fixture();
    const atlas = rt.state.get("Agent", NS, AGENT);
    await rt.apply({ ...atlas, spec: { ...atlas.spec, hands: { security: { userNamespace: true } } } });
    await rt.reconcile();
    const handsDep = await kube.get(NS, "Deployment", `hands-${AGENT}`);
    const podSpec = handsDep.spec.template.spec;
    const container = podSpec.containers[0];
    // Fake root inside the pod, but hostUsers:false means it maps to an
    // unprivileged host uid — pod-internal root without node privilege.
    assert.equal(container.securityContext.runAsUser, 0, "fake root (uid 0) inside the pod");
    assert.equal(container.securityContext.runAsNonRoot, false, "runAsNonRoot false for the fake root");
    assert.equal(podSpec.securityContext.hostUsers, false, "user namespace isolates the root");
});

test("milestone: a connector is governed + discoverable + callable end-to-end", async () => {
    // End-to-end through the controller: apply a Connector, reconcile, and prove
    // (1) the kernel ensured an egress NetworkPolicy (governance),
    // (2) the brain pod received HADES_CONNECTORS env (discovery),
    // (3) the brain-side adapter (ConnectorToolRegistrar) can call the endpoint.
    const { rt, kube } = await fixture();
    await rt.apply({ kind: "Connector", metadata: { namespace: NS, name: "echo" }, spec: { agentRef: AGENT, endpoint: "https://echo.example.com", egress: "restricted-web" } });
    await rt.reconcile();

    // (1) Governance: the NetworkPolicy exists, scoped to the brain pod.
    const policy = await kube.get(NS, "NetworkPolicy", "connector-echo");
    assert.ok(policy, "egress NetworkPolicy ensured");
    assert.equal(policy.spec.podSelector.matchLabels["hades.dev/agent"], AGENT);

    // (2) Discovery: the brain pod env carries the connector manifest.
    const brainDep = await kube.get(NS, "Deployment", `brain-${AGENT}`);
    const env = brainDep.spec.template.spec.containers[0].env;
    const manifest = JSON.parse(env.find((e) => e.name === "HADES_CONNECTORS").value);
    assert.equal(manifest[0].name, "echo");

    // (3) Callable: the brain-side adapter (userland) reads the manifest + calls.
    let calledUrl = "";
    const fakeFetch = async (url) => { calledUrl = url; return new Response("{}", { status: 200 }); };
    const policy2 = { can: () => ({ allowed: true }), assert: () => ({ allowed: true }) };
    const secrets = { get: async () => undefined };
    const Type = { Object: (s) => s, String: () => ({}), Optional: (v) => v, Array: (v) => v };
    const tools = {};
    const api = { registerTool: (t) => { tools[t.name] = t; } };
    const { ConnectorToolRegistrar, connectorsFromEnv } = await import("../dist/adapters/brain/ConnectorToolRegistrar.js");
    // Simulate the brain pod reading its injected env.
    const envConnectors = connectorsFromEnv({ HADES_CONNECTORS: JSON.stringify(manifest) });
    new ConnectorToolRegistrar(
        { kind: "Agent", name: AGENT, namespace: NS }, policy2, secrets, (d) => d, Type, envConnectors, fakeFetch,
    ).register(api);
    const result = await tools["hades_call_echo"].execute("id", { path: "/hi", method: "GET" });
    assert.equal(calledUrl, "https://echo.example.com/hi", "adapter called the discovered endpoint");
    assert.match(result.content[0].text, /^200/);
});

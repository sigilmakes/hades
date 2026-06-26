import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime } from "../dist/runtime/HadesRuntime.js";
import { FakeKubeClient } from "../dist/adapters/kube/FakeKubeClient.js";
import { PrometheusMetrics } from "../dist/adapters/metrics/PrometheusMetrics.js";
import { noopLogger, noopMetrics } from "../dist/ports/Observability.js";
import { createServer } from "../dist/adapters/api/server.js";

const NS = "agent-atlas";

async function fixture(metrics = new PrometheusMetrics()) {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-metrics-"));
    const kube = new FakeKubeClient();
    const rt = await (await createRuntime(dir, { kubeClient: kube, metrics, logger: noopLogger })).init();
    await rt.apply({ kind: "Home", metadata: { namespace: NS, name: "h" }, spec: {} });
    await rt.apply({ kind: "Agent", metadata: { namespace: NS, name: "atlas" }, spec: { homeRef: "h", defaultSession: "atlas-default", desiredState: "active", brain: { mode: "test" } } });
    return { dir, rt, kube, metrics };
}

test("PrometheusMetrics: counters accumulate and render in text format", () => {
    const m = new PrometheusMetrics();
    m.inc("hades_reconcile_total");
    m.inc("hades_reconcile_total");
    m.inc("hads_resource_reconciled_total", { kind: "Agent" });
    const out = m.render();
    assert.match(out, /# TYPE hades_reconcile_total counter/);
    assert.match(out, /^hades_reconcile_total 2$/m);
    assert.match(out, /hads_resource_reconciled_total\{kind="Agent"\} 1/);
});

test("PrometheusMetrics: gauges set absolute values per label set", () => {
    const m = new PrometheusMetrics();
    m.set("hades_pod_phase", { kind: "Agent", phase: "active" }, 3);
    m.set("hades_pod_phase", { kind: "Agent", phase: "active" }, 2); // replaces, not adds
    m.set("hades_pod_phase", { kind: "Hands", phase: "ready" }, 1);
    const out = m.render();
    assert.match(out, /# TYPE hades_pod_phase gauge/);
    assert.match(out, /hades_pod_phase\{kind="Agent",phase="active"\} 2/);
    assert.match(out, /hades_pod_phase\{kind="Hands",phase="ready"\} 1/);
});

test("PrometheusMetrics: histograms emit _bucket/_sum/_count with le buckets", () => {
    const m = new PrometheusMetrics();
    m.observe("hades_reconcile_seconds", undefined, 0.02);
    m.observe("hades_reconcile_seconds", undefined, 1.3);
    const out = m.render();
    assert.match(out, /# TYPE hades_reconcile_seconds histogram/);
    assert.match(out, /hades_reconcile_seconds_bucket\{le="0\.05"\} 1/);
    assert.match(out, /hades_reconcile_seconds_bucket\{le="\+Inf"\} 2/);
    assert.match(out, /hades_reconcile_seconds_count 2/);
    assert.match(out, /hades_reconcile_seconds_sum 1\.32/);
});

test("noopMetrics renders a disabled comment and records nothing", () => {
    noopMetrics.inc("anything");
    noopMetrics.set("anything", { l: "v" }, 5);
    noopMetrics.observe("anything", undefined, 1);
    assert.match(noopMetrics.render(), /disabled/);
});

test("the controller records reconcile + per-kind metrics on a reconcile pass", async () => {
    const { rt, metrics } = await fixture();
    // A connector + skill so those reconcile paths run too.
    await rt.apply({ kind: "Connector", metadata: { namespace: NS, name: "github" }, spec: { agentRef: "atlas", endpoint: "https://api.github.com", egress: "restricted-web" } });
    await rt.apply({ kind: "Skill", metadata: { namespace: NS, name: "search" }, spec: { agentRef: "atlas", port: 8080 } });
    await rt.reconcile();
    const out = metrics.render();
    assert.match(out, /hades_reconcile_total \d+/);
    assert.match(out, /hades_resource_reconciled_total\{kind="Home"\} [1-9]/);
    assert.match(out, /hades_resource_reconciled_total\{kind="Agent"\} [1-9]/);
    assert.match(out, /hades_resource_reconciled_total\{kind="Connector"\} [1-9]/);
    assert.match(out, /hades_resource_reconciled_total\{kind="Skill"\} [1-9]/);
    assert.match(out, /hades_reconcile_seconds_count [1-9]/);
    // Pod-phase gauge reflects the active agent.
    assert.match(out, /hades_pod_phase\{kind="Agent",phase="active"\} [1-9]/);
});

test("a failed reconcile increments the error counter", async () => {
    const { rt, kube, metrics } = await fixture();
    // Force a reconcile failure: kube.get is the first cluster call in
    // ensureHadesResources, so throwing there deterministically fails the pass.
    kube.get = async () => { throw new Error("cluster down"); };
    await assert.rejects(rt.reconcile(), /cluster down/);
    const out = metrics.render();
    assert.match(out, /hades_reconcile_total [1-9]/);
    assert.match(out, /hades_reconcile_errors_total [1-9]/);
});

test("GET /metrics returns Prometheus text from the runtime's metrics adapter", async () => {
    const metrics = new PrometheusMetrics();
    metrics.inc("hades_reconcile_total");
    const dir = await mkdtemp(path.join(tmpdir(), "hades-metrics-api-"));
    const rt = await (await createRuntime(dir, { metrics })).init();
    const server = createServer(rt);
    await new Promise((r) => server.listen(0, r));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/metrics`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("content-type"), "text/plain; version=0.0.4; charset=utf-8");
        const body = await res.text();
        assert.match(body, /# TYPE hades_reconcile_total counter/);
    } finally { await new Promise((r) => server.close(r)); }
});

test("a runtime without an injected metrics adapter serves a disabled comment at /metrics", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-metrics-none-"));
    const rt = await (await createRuntime(dir)).init();
    const server = createServer(rt);
    await new Promise((r) => server.listen(0, r));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/metrics`);
        const body = await res.text();
        assert.match(body, /disabled/);
    } finally { await new Promise((r) => server.close(r)); }
});

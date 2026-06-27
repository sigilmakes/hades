import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntime } from "../dist/runtime/HadesRuntime.js";
import { FakeKubeClient } from "../dist/adapters/kube/FakeKubeClient.js";
import { KubeController } from "../dist/controller/KubeController.js";

const NS = "gitops-test";

/**
 * #53: kubectl apply / GitOps watch. The controller watches the cluster for
 * Hades CRD changes and feeds them back into the local state store. This test
 * simulates `kubectl apply` and `kubectl delete` by calling ensure/delete on
 * the FakeKubeClient (which emits watch events) and asserts the state store
 * reflects the change.
 */
test("kubectl apply of an Agent CR reaches the state store via watch (#53)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-gitops-"));
    const kube = new FakeKubeClient();
    const runtime = await (await createRuntime(dir, { kubeClient: kube })).init();
    // Start the controller watch loop.
    const stop = runtime.controller.start();
    try {
        // Simulate `kubectl apply -f agent.yaml` — a Hades CRD applied directly
        // to the cluster (not through the API). The watch should pick it up.
        await kube.ensure(NS, {
            apiVersion: "hades.dev/v1alpha1",
            kind: "Agent",
            metadata: { name: "gitops-agent", namespace: NS },
            spec: { desiredState: "active", brain: { mode: "test" } },
        });
        // Give the debounced reconcile a moment to fire.
        await new Promise((r) => setTimeout(r, 500));
        // The agent should now be in the local state store.
        const agent = runtime.state.findByName("Agent", "gitops-agent", NS);
        assert.ok(agent, "kubectl-applied Agent reached the state store via watch");
        assert.equal(agent.spec?.desiredState, "active");
    } finally {
        stop();
    }
});

test("kubectl delete of an Agent CR is reflected in the state store via watch (#53)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-gitops-del-"));
    const kube = new FakeKubeClient();
    const runtime = await (await createRuntime(dir, { kubeClient: kube })).init();
    // Apply an agent through the API first.
    await runtime.apply({ kind: "Agent", metadata: { namespace: NS, name: "to-delete" }, spec: { desiredState: "active", brain: { mode: "test" } } });
    assert.ok(runtime.state.findByName("Agent", "to-delete", NS));
    // Reconcile so the CRD is in the fake cluster (the watch deletes from there).
    await runtime.reconcile();
    assert.ok(await kube.get(NS, "Agent", "to-delete"), "CRD is in the fake cluster");
    const stop = runtime.controller.start();
    try {
        // Simulate `kubectl delete agent to-delete`.
        await kube.delete(NS, "Agent", "to-delete");
        await new Promise((r) => setTimeout(r, 500));
        // The agent should be gone from the state store.
        const agent = runtime.state.findByName("Agent", "to-delete", NS);
        assert.equal(agent, undefined, "kubectl-deleted Agent was removed from the state store via watch");
    } finally {
        stop();
    }
});

test("watch is idempotent — re-applying the same CR doesn't cause issues", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hades-gitops-idem-"));
    const kube = new FakeKubeClient();
    const runtime = await (await createRuntime(dir, { kubeClient: kube })).init();
    const stop = runtime.controller.start();
    try {
        const crd = {
            apiVersion: "hades.dev/v1alpha1",
            kind: "Agent",
            metadata: { name: "idem", namespace: NS },
            spec: { desiredState: "active", brain: { mode: "test" } },
        };
        await kube.ensure(NS, crd);
        await new Promise((r) => setTimeout(r, 300));
        await kube.ensure(NS, crd); // identical re-apply
        await new Promise((r) => setTimeout(r, 300));
        const agent = runtime.state.findByName("Agent", "idem", NS);
        assert.ok(agent, "agent exists after idempotent re-apply");
    } finally {
        stop();
    }
});

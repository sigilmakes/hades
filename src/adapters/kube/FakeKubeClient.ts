import type { KubeClient, KubeObject, ExecResult } from "../../ports/KubeClient.js";

/**
 * An in-memory {@link KubeClient} for tests and dev mode — no real cluster
 * needed. Objects are stored by `namespace/kind/name`. `ensure` is idempotent
 * (create-or-update); `delete` removes; `list` filters by namespace + kind.
 *
 * Exposes the underlying store via {@link objects} so tests can assert what the
 * controller reconciled into the (fake) cluster.
 */
export class FakeKubeClient implements KubeClient {
    /** All objects, keyed by `namespace/kind/name`. */
    readonly objects = new Map<string, KubeObject>();

    async ensure(namespace: string, object: KubeObject): Promise<string> {
        const name = object.metadata.name;
        const key = this.key(namespace, object.kind, name);
        const hadesKinds = new Set(["Agent", "Home", "Hands", "Session", "BrainBinding", "Listener", "Schedule", "Run", "Approval", "CapabilityGrant", "AgentClass"]);
        // Stamp a synthetic uid on Hades CRDs (a real cluster assigns one) so
        // ownerReferences resolve in tests.
        const uid = hadesKinds.has(object.kind) ? `fake-${object.kind}-${name}` : object.metadata.uid;
        const existed = this.objects.has(key);
        this.objects.set(key, { ...object, metadata: { ...object.metadata, namespace, ...(uid ? { uid } : {}) } });
        // Emit a watch event so the controller's GitOps path sees external applies.
        if (hadesKinds.has(object.kind)) {
            this.emitWatch(existed ? "MODIFIED" : "ADDED", this.objects.get(key)!);
        }
        return name;
    }

    async delete(namespace: string, kind: string, name: string): Promise<boolean> {
        const key = this.key(namespace, kind, name);
        const existed = this.objects.get(key);
        const deleted = this.objects.delete(key);
        if (deleted && existed) this.emitWatch("DELETED", existed);
        return deleted;
    }

    async patchMetadata(namespace: string, kind: string, name: string, patch: Record<string, unknown>): Promise<void> {
        const obj = await this.get(namespace, kind, name);
        if (!obj) return;
        obj.metadata = { ...obj.metadata, ...patch };
    }

    async list(namespace: string, kind: string): Promise<KubeObject[]> {
        const _prefix = `${namespace}/${kind}/`;
        return [...this.objects.values()].filter((obj) => {
            const objNs = obj.metadata.namespace ?? namespace;
            return objNs === namespace && obj.kind === kind;
        });
    }

    async healthz(): Promise<boolean> {
        return true;
    }

    async get(namespace: string, kind: string, name: string): Promise<KubeObject | undefined> {
        return this.objects.get(this.key(namespace, kind, name));
    }

    async patchStatus(namespace: string, kind: string, name: string, status: Record<string, unknown>): Promise<void> {
        // Record the status patch on the fake object so tests can assert it was called.
        const key = this.key(namespace, kind, name);
        const existing = this.objects.get(key);
        if (existing) existing.status = { ...(existing.status ?? {}), ...status };
        this.statusPatches.push({ namespace, kind, name, status });
    }

    /** Status patches the controller issued (test assertions). */
    readonly statusPatches: Array<{ namespace: string; kind: string; name: string; status: Record<string, unknown> }> = [];

    async getSecret(namespace: string, name: string): Promise<Record<string, string> | undefined> {
        const secret = this.secrets.get(this.key(namespace, "Secret", name));
        return secret ? { ...secret } : undefined;
    }

    /** Seed a fake Secret (test helper). */
    seedSecret(namespace: string, name: string, data: Record<string, string>): void {
        this.secrets.set(this.key(namespace, "Secret", name), data);
    }
    private readonly secrets = new Map<string, Record<string, string>>();

    async exec(_namespace: string, _pod: string, _container: string, command: string[], _stdin?: string): Promise<ExecResult> {
        // The fake client cannot exec into a real pod. Tests that need exec
        // behavior inject a custom KubeClient or assert via the controller's
        // ensured objects rather than execution results.
        void command;
        throw new Error("FakeKubeClient cannot exec into pods; inject a custom KubeClient for exec tests");
    }

    /** Per-pod log text, keyed by `${namespace}/${pod}`. Seed via {@link seedLogs}. */
    readonly podLogs = new Map<string, string>();
    seedLogs(namespace: string, pod: string, text: string): void { this.podLogs.set(`${namespace}/${pod}`, text); }
    async logs(namespace: string, pod: string, _container: string): Promise<string> {
        return this.podLogs.get(`${namespace}/${pod}`) ?? "";
    }

    private key(namespace: string, kind: string, name: string): string {
        return `${namespace}/${kind}/${name}`;
    }

    /** Watch handlers registered via watchResources. */
    private readonly watchers: Array<(phase: "ADDED" | "MODIFIED" | "DELETED", obj: KubeObject) => void> = [];

    /** Emit a watch event to all registered watchers (simulates k8s watch). */
    private emitWatch(phase: "ADDED" | "MODIFIED" | "DELETED", obj: KubeObject): void {
        for (const w of this.watchers) w(phase, obj);
    }

    /**
     * Register a watch handler. Returns a stop function. The fake emits
     * ADDED/MODIFIED/DELETED when ensure/delete are called on Hades CRDs,
     * simulating `kubectl apply`/`kubectl delete` reaching the controller.
     */
    async watchResources(handler: (phase: "ADDED" | "MODIFIED" | "DELETED", obj: KubeObject) => void): Promise<() => void> {
        this.watchers.push(handler);
        return () => {
            const i = this.watchers.indexOf(handler);
            if (i >= 0) this.watchers.splice(i, 1);
        };
    }
}

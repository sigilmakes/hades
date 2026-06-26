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
        this.objects.set(key, { ...object, metadata: { ...object.metadata, namespace } });
        return name;
    }

    async delete(namespace: string, kind: string, name: string): Promise<boolean> {
        const key = this.key(namespace, kind, name);
        return this.objects.delete(key);
    }

    async list(namespace: string, kind: string): Promise<KubeObject[]> {
        const prefix = `${namespace}/${kind}/`;
        return [...this.objects.values()].filter((obj) => {
            const objNs = obj.metadata.namespace ?? namespace;
            return objNs === namespace && obj.kind === kind;
        });
    }

    async healthz(): Promise<boolean> {
        return true;
    }

    async get(namespace: string, kind: string, name: string): Promise<KubeObject | undefined> {
        const existing = this.objects.get(this.key(namespace, kind, name));
        if (existing) return existing;
        // Hades CRDs (Agent/Home/Hands/Schedule/...) are the owners of native
        // objects. In a real cluster they exist as CRDs with server-assigned
        // uids. The fake synthesizes a uid so ownerReferences resolve in tests.
        const hadesKinds = new Set(["Agent", "Home", "Hands", "Session", "BrainBinding", "Listener", "Schedule", "Run", "Approval", "CapabilityGrant", "AgentClass"]);
        if (hadesKinds.has(kind)) {
            return { apiVersion: "hades.dev/v1alpha1", kind, metadata: { name, namespace, uid: `fake-${kind}-${name}` } };
        }
        return undefined;
    }

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

    private key(namespace: string, kind: string, name: string): string {
        return `${namespace}/${kind}/${name}`;
    }
}

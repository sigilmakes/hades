import type { KubeClient, KubeObject } from "../../ports/KubeClient.js";

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

    /** Get a single object (test helper). */
    get(namespace: string, kind: string, name: string): KubeObject | undefined {
        return this.objects.get(this.key(namespace, kind, name));
    }

    private key(namespace: string, kind: string, name: string): string {
        return `${namespace}/${kind}/${name}`;
    }
}

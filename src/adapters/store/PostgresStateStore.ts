import pg, { type Pool } from "pg";
import { emptyState, KINDS, resourceKey, type HadesKind, type HadesResource, type HadesState } from "../../domain/resources.js";
import type { StateStorePort } from "../../ports/StateStore.js";

/**
 * A durable state store backed by Postgres — the production target for
 * multi-node or high-write-volume deployments. Satisfies {@link StateStorePort};
 * a drop-in replacement for `SqliteStateStore` behind the same port.
 *
 * A single `resources` table holds all Hades resources keyed by `kind` +
 * `namespace/name`, with the full resource JSON as the value. Swap the
 * substrate by injecting this store into `createRuntime({ stateStore })`.
 *
 * Requires `DATABASE_URL` (or an injected `Pool`). The schema is created on
 * `init` if absent.
 */
export class PostgresStateStore implements StateStorePort {
    state: HadesState = emptyState();
    private readonly pool: Pool;

    constructor(options: PostgresStateStoreOptions = {}) {
        this.pool = options.pool ?? new pg.Pool({ connectionString: process.env.DATABASE_URL });
    }

    async init(): Promise<void> {
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS resources (
                kind TEXT NOT NULL,
                key TEXT NOT NULL,
                doc JSONB NOT NULL,
                PRIMARY KEY (kind, key)
            );
        `);
        await this.load();
    }

    async load(): Promise<HadesState> {
        this.state = emptyState();
        const result = await this.pool.query("SELECT kind, doc FROM resources");
        for (const row of result.rows as Array<{ kind: string; doc: HadesResource }>) {
            const resource = row.doc;
            const key = resourceKey(resource);
            (this.state[row.kind as HadesKind] ??= {})[key] = resource;
        }
        return this.state;
    }

    async save(): Promise<void> {
        // No-op: mutations apply directly via apply/remove below. Kept for the port.
    }

    async apply(resource: HadesResource): Promise<HadesResource> {
        if (!KINDS.includes(resource.kind as HadesKind)) throw new Error(`Unsupported kind ${resource.kind}`);
        resource.apiVersion ??= "hades.dev/v1alpha1";
        resource.metadata ??= { name: "" };
        resource.metadata.namespace ??= "default";
        resource.status ??= {};
        const key = resourceKey(resource);
        const doc = JSON.stringify(resource);
        await this.pool.query(
            `INSERT INTO resources (kind, key, doc) VALUES ($1, $2, $3)
             ON CONFLICT (kind, key) DO UPDATE SET doc = EXCLUDED.doc`,
            [resource.kind, key, doc],
        );
        (this.state[resource.kind as HadesKind] ??= {})[key] = resource;
        return resource;
    }

    async patch(kind: HadesKind, namespace: string, name: string, patch: Partial<HadesResource>): Promise<HadesResource> {
        const resource = this.get(kind, namespace, name);
        if (!resource) throw new Error(`${kind} ${namespace}/${name} not found`);
        const updated = { ...resource, ...patch, spec: { ...resource.spec, ...patch.spec }, status: { ...resource.status, ...patch.status } };
        return this.apply(updated);
    }

    async remove(kind: HadesKind, namespace: string, name: string): Promise<boolean> {
        const existed = this.get(kind, namespace, name);
        if (!existed) return false;
        await this.pool.query("DELETE FROM resources WHERE kind = $1 AND key = $2", [kind, resourceKey(existed)]);
        const key = resourceKey(existed);
        delete this.state[kind][key];
        return true;
    }

    get(kind: HadesKind, namespace: string, name: string): HadesResource | undefined {
        return this.state[kind][`${namespace}/${name}`];
    }

    list(kind: HadesKind, namespace?: string): HadesResource[] {
        const resources = Object.values(this.state[kind] ?? {});
        if (!namespace) return resources;
        return resources.filter((r) => (r.metadata?.namespace ?? "default") === namespace);
    }

    findByName(kind: HadesKind, name: string, namespace?: string): HadesResource | undefined {
        const resources = this.list(kind, namespace);
        return resources.find((r) => r.metadata?.name === name);
    }

    async close(): Promise<void> {
        await this.pool.end();
    }
}

export type PostgresStateStoreOptions = {
    pool?: Pool;
};

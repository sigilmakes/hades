import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { emptyState, KINDS, resourceKey, type HadesKind, type HadesResource, type HadesState } from "../../domain/resources.js";
import type { StateStorePort } from "../../ports/StateStore.js";

/**
 * A durable state store backed by SQLite on a PVC.
 *
 * A single `resources` table holds all Hades resources keyed by `kind` +
 * `namespace/name`, with the full resource JSON as the value. Satisfies
 * {@link StateStorePort} — a drop-in replacement for `JsonStateStore` that
 * survives pod restarts.
 *
 * The in-memory `state` mirror is loaded on `init` and kept in sync on every
 * mutation, so kernel services that read `state` (the `findByName`/`list`
 * hot paths) stay O(1)/O(n)-in-memory, not per-call SQL.
 */
export class SqliteStateStore implements StateStorePort {
    readonly dataDir: string;
    readonly dbPath: string;
    state: HadesState = emptyState();
    private db!: DatabaseSync;

    constructor(dataDir: string) {
        this.dataDir = dataDir;
        this.dbPath = path.join(dataDir, "state.db");
    }

    async init(): Promise<void> {
        await mkdir(this.dataDir, { recursive: true });
        this.db = new DatabaseSync(this.dbPath);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS resources (
                kind TEXT NOT NULL,
                key TEXT NOT NULL,
                doc TEXT NOT NULL,
                PRIMARY KEY (kind, key)
            );
        `);
        await this.load();
    }

    async load(): Promise<HadesState> {
        this.state = emptyState();
        const rows = this.db.prepare("SELECT kind, doc FROM resources").all() as Array<{ kind: string; doc: string }>;
        for (const row of rows) {
            const resource = JSON.parse(row.doc) as HadesResource;
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
        this.db.prepare(
            "INSERT INTO resources (kind, key, doc) VALUES (?, ?, ?) ON CONFLICT(kind, key) DO UPDATE SET doc = excluded.doc",
        ).run(resource.kind, key, doc);
        (this.state[resource.kind as HadesKind] ??= {})[key] = resource;
        return resource;
    }

    async patch(kind: HadesKind, namespace: string, name: string, patch: Partial<HadesResource>): Promise<HadesResource> {
        const resource = this.get(kind, namespace, name);
        if (!resource) throw new Error(`${kind} ${namespace}/${name} not found`);
        Object.assign(resource.status ??= {}, patch.status ?? {});
        Object.assign(resource.spec ??= {}, patch.spec ?? {});
        return this.apply(resource);
    }

    async remove(kind: HadesKind, namespace: string, name: string): Promise<boolean> {
        const key = `${namespace}/${name}`;
        const existed = Boolean(this.state[kind]?.[key]);
        if (existed) {
            this.db.prepare("DELETE FROM resources WHERE kind = ? AND key = ?").run(kind, key);
            delete this.state[kind][key];
        }
        return existed;
    }

    get(kind: HadesKind, namespace: string, name: string): HadesResource | undefined {
        return this.state[kind]?.[`${namespace}/${name}`];
    }

    list(kind: HadesKind, namespace?: string): HadesResource[] {
        const values = Object.values(this.state[kind] ?? {});
        return namespace ? values.filter((item) => item.metadata?.namespace === namespace) : values;
    }

    findByName(kind: HadesKind, name: string, namespace?: string): HadesResource | undefined {
        return this.list(kind, namespace).find((item) => item.metadata?.name === name);
    }

    close(): void {
        this.db?.close();
    }
}

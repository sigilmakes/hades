import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { emptyState, KINDS, resourceKey, type HadesKind, type HadesResource, type HadesState } from "../../domain/resources.js";
import type { StateStorePort } from "../../ports/StateStore.js";

export class JsonStateStore implements StateStorePort {
    readonly dataDir: string;
    readonly file: string;
    state: HadesState = emptyState();

    constructor(dataDir: string) {
        this.dataDir = dataDir;
        this.file = path.join(dataDir, "state.json");
    }

    async init(): Promise<void> {
        await mkdir(this.dataDir, { recursive: true });
        await this.load();
    }

    async load(): Promise<HadesState> {
        const raw = await readFile(this.file, "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
        });
        this.state = raw ? JSON.parse(raw) : emptyState();
        for (const kind of KINDS) this.state[kind] ??= {};
        return this.state;
    }

    async save(): Promise<void> {
        await mkdir(this.dataDir, { recursive: true });
        await writeFile(this.file, JSON.stringify(this.state, null, 4) + "\n", "utf8");
    }

    async apply(resource: HadesResource): Promise<HadesResource> {
        if (!KINDS.includes(resource.kind as HadesKind)) throw new Error(`Unsupported kind ${resource.kind}`);
        resource.apiVersion ??= "hades.dev/v1alpha1";
        resource.metadata ??= { name: "" };
        resource.metadata.namespace ??= "default";
        resource.status ??= {};
        this.state[resource.kind as HadesKind][resourceKey(resource)] = resource;
        await this.save();
        return resource;
    }

    async patch(kind: HadesKind, namespace: string, name: string, patch: Partial<HadesResource>): Promise<HadesResource> {
        const resource = this.get(kind, namespace, name);
        if (!resource) throw new Error(`${kind} ${namespace}/${name} not found`);
        Object.assign(resource.status ??= {}, patch.status ?? {});
        Object.assign(resource.spec ??= {}, patch.spec ?? {});
        await this.save();
        return resource;
    }

    async remove(kind: HadesKind, namespace: string, name: string): Promise<boolean> {
        const key = `${namespace}/${name}`;
        const existed = Boolean(this.state[kind]?.[key]);
        if (existed) {
            delete this.state[kind][key];
            await this.save();
        }
        return existed;
    }

    get(kind: HadesKind, namespace: string, name: string): HadesResource | undefined {
        return this.state[kind]?.[`${namespace}/${name}`];
    }

    list(kind: HadesKind, namespace: string | undefined = undefined): HadesResource[] {
        const values = Object.values(this.state[kind] ?? {});
        return namespace ? values.filter((item) => item.metadata?.namespace === namespace) : values;
    }

    findByName(kind: HadesKind, name: string, namespace: string | undefined = undefined): HadesResource | undefined {
        return this.list(kind, namespace).find((item) => item.metadata?.name === name);
    }
}

export function dataDirFromEnv(): string {
    return process.env.HADES_DATA_DIR || path.resolve(process.cwd(), ".hades");
}

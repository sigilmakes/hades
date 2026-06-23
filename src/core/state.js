import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const KINDS = [
    "Agent",
    "AgentClass",
    "Home",
    "Session",
    "BrainBinding",
    "Hands",
    "Listener",
    "Schedule",
    "Run",
    "Approval",
    "CapabilityGrant",
];

const EMPTY = Object.fromEntries(KINDS.map((kind) => [kind, {}]));

export class StateStore {
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.file = path.join(dataDir, "state.json");
    }

    async init() {
        await mkdir(this.dataDir, { recursive: true });
        await this.load();
    }

    async load() {
        const raw = await readFile(this.file, "utf8").catch((error) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
        });
        this.state = raw ? JSON.parse(raw) : structuredClone(EMPTY);
        for (const kind of KINDS) this.state[kind] ??= {};
        return this.state;
    }

    async save() {
        await mkdir(this.dataDir, { recursive: true });
        await writeFile(this.file, JSON.stringify(this.state, null, 4) + "\n", "utf8");
    }

    key(resource) {
        const namespace = resource.metadata?.namespace ?? "default";
        const name = resource.metadata?.name;
        if (!name) throw new Error(`${resource.kind} is missing metadata.name`);
        return `${namespace}/${name}`;
    }

    async apply(resource) {
        if (!KINDS.includes(resource.kind)) throw new Error(`Unsupported kind ${resource.kind}`);
        resource.apiVersion ??= "hades.dev/v1alpha1";
        resource.metadata ??= {};
        resource.metadata.namespace ??= "default";
        resource.status ??= {};
        this.state[resource.kind][this.key(resource)] = resource;
        await this.save();
        return resource;
    }

    async patch(kind, namespace, name, patch) {
        const resource = this.get(kind, namespace, name);
        if (!resource) throw new Error(`${kind} ${namespace}/${name} not found`);
        Object.assign(resource.status ??= {}, patch.status ?? {});
        Object.assign(resource.spec ??= {}, patch.spec ?? {});
        await this.save();
        return resource;
    }

    get(kind, namespace, name) {
        return this.state[kind]?.[`${namespace}/${name}`];
    }

    list(kind, namespace = undefined) {
        const values = Object.values(this.state[kind] ?? {});
        return namespace ? values.filter((item) => item.metadata?.namespace === namespace) : values;
    }

    findByName(kind, name, namespace = undefined) {
        return this.list(kind, namespace).find((item) => item.metadata?.name === name);
    }
}

export function dataDirFromEnv() {
    return process.env.HADES_DATA_DIR || path.resolve(process.cwd(), ".hades");
}

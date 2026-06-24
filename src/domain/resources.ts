export type Metadata = {
    namespace?: string;
    name: string;
};

export type HadesResource = {
    apiVersion?: string;
    kind: string;
    metadata?: Metadata;
    spec?: Record<string, any>;
    status?: Record<string, any>;
};

export type AgentSubject = {
    kind: "Agent";
    name: string;
    namespace: string;
};

export type ToolResult = {
    code: number;
    signal?: NodeJS.Signals | string | null;
    stdout: string;
    stderr: string;
};

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
] as const;

export type HadesKind = typeof KINDS[number];
export type HadesState = Record<HadesKind, Record<string, HadesResource>>;

export function emptyState(): HadesState {
    return Object.fromEntries(KINDS.map((kind) => [kind, {}])) as HadesState;
}

export function resourceKey(resource: HadesResource): string {
    return `${namespaceOf(resource)}/${nameOf(resource)}`;
}

export function nameOf(resource: HadesResource): string {
    const name = resource.metadata?.name;
    if (!name) throw new Error(`${resource.kind} is missing metadata.name`);
    return name;
}

export function namespaceOf(resource: HadesResource): string {
    return resource.metadata?.namespace ?? "default";
}

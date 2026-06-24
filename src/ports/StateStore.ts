import type { HadesKind, HadesResource, HadesState } from "../domain/resources.js";

export interface StateStorePort {
    state: HadesState;
    init(): Promise<void>;
    load(): Promise<HadesState>;
    save(): Promise<void>;
    apply(resource: HadesResource): Promise<HadesResource>;
    patch(kind: HadesKind, namespace: string, name: string, patch: Partial<HadesResource>): Promise<HadesResource>;
    get(kind: HadesKind, namespace: string, name: string): HadesResource | undefined;
    list(kind: HadesKind, namespace?: string): HadesResource[];
    findByName(kind: HadesKind, name: string, namespace?: string): HadesResource | undefined;
}

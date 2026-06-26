import type { HadesKind, HadesResource, HadesState } from "../domain/resources.js";

/** A mutation of the state store, broadcast to subscribers. */
export interface StateChange {
    kind: HadesKind;
    namespace: string;
    name: string;
    /** "apply" (create or update) or "remove". */
    op: "apply" | "remove";
}

export interface StateStorePort {
    state: HadesState;
    init(): Promise<void>;
    load(): Promise<HadesState>;
    save(): Promise<void>;
    apply(resource: HadesResource): Promise<HadesResource>;
    patch(kind: HadesKind, namespace: string, name: string, patch: Partial<HadesResource>): Promise<HadesResource>;
    /** Remove a resource. Returns true if it existed. */
    remove(kind: HadesKind, namespace: string, name: string): Promise<boolean>;
    get(kind: HadesKind, namespace: string, name: string): HadesResource | undefined;
    list(kind: HadesKind, namespace?: string): HadesResource[];
    findByName(kind: HadesKind, name: string, namespace?: string): HadesResource | undefined;
    /** Stream state mutations after subscription. Returns an unsubscribe fn. */
    subscribe?(handler: (change: StateChange) => void): () => void;
}

import type { HadesResource } from "../domain/resources.js";

/**
 * A minimal Kubernetes client port — the seam between the Hades controller and
 * a real cluster. The controller reasons about Hades resources and asks the
 * client to ensure native k8s objects exist (idempotent apply/upsert).
 *
 * A {@link FakeKubeClient} satisfies this for tests (no cluster needed);
 * `KubeClientNode` satisfies it for deploy mode against a live cluster.
 *
 * Design: the controller computes the *intended* k8s objects for a Hades
 * resource and calls `ensure`. The client makes reality match intent. This
 * keeps the controller cluster-agnostic and testable.
 */
export interface KubeClient {
    /** Idempotently apply (create-or-update) a k8s object. Returns the object name. */
    ensure(namespace: string, object: KubeObject): Promise<string>;
    /** Idempotently delete a k8s object if it exists. Returns true if deleted. */
    delete(namespace: string, kind: string, name: string): Promise<boolean>;
    /** List objects of a kind in a namespace. */
    list(namespace: string, kind: string): Promise<KubeObject[]>;
    /** Health check. */
    healthz(): Promise<boolean>;
    /** Exec a command in a pod's container. Returns stdout/stderr + exit code. */
    exec(namespace: string, pod: string, container: string, command: string[], stdin?: string): Promise<ExecResult>;
}

/** A minimal k8s object shape the controller produces. */
export interface KubeObject {
    apiVersion: string;
    kind: string;
    metadata: { name: string; namespace?: string; labels?: Record<string, string>; ownerReferences?: Array<{ apiVersion: string; kind: string; name: string; uid?: string; blockOwnerDeletion?: boolean; controller?: boolean }> };
    spec?: Record<string, any>;
    /** Wire format role/selector strings, etc. kept as opaque for the client. */
}

/** Result of an exec into a pod. */
export interface ExecResult {
    code: number;
    stdout: string;
    stderr: string;
}

/** Labels the controller stamps on every object it owns. */
export const HADES_LABELS = {
    managedBy: "hades.dev/managed-by",
    hadesKind: "hades.dev/kind",
    hadesName: "hades.dev/name",
} as const;

export const HADES_CONTROLLER_VALUE = "hades-controller";

/** Build the standard hades labels for an owned object. */
export function hadesLabels(resource: HadesResource): Record<string, string> {
    return {
        [HADES_LABELS.managedBy]: HADES_CONTROLLER_VALUE,
        [HADES_LABELS.hadesKind]: resource.kind,
        [HADES_LABELS.hadesName]: resource.metadata?.name ?? "",
    };
}

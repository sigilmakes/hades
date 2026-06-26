import * as k8s from "@kubernetes/client-node";
import { PassThrough } from "node:stream";
import type { KubeClient, KubeObject, ExecResult } from "../../ports/KubeClient.js";

/** A k8s API error carries a numeric statusCode (the client throws objects, not Error). */
function kubeStatus(error: unknown): number | undefined {
    if (error && typeof error === "object") {
        const e = error as { statusCode?: number; code?: number };
        if (typeof e.statusCode === "number") return e.statusCode;
        if (typeof e.code === "number") return e.code;
    }
    return undefined;
}

/**
 * A real {@link KubeClient} backed by `@kubernetes/client-node` for deploy
 * mode. Loads cluster config from the standard locations (in-cluster
 * ServiceAccount, kubeconfig, or `KUBECONFIG`/`~/.kube/config`).
 *
 * `ensure` is idempotent create-or-update against the live cluster. The
 * controller computes intended k8s objects; this client makes reality match.
 *
 * This is the only place Hades touches the k8s API directly — everything else
 * reasons about Hades resources and asks the client to ensure native objects.
 * Tests use {@link FakeKubeClient}; this is for real deploy.
 */
export class KubeClientNode implements KubeClient {
    private readonly kc: k8s.KubeConfig;
    private readonly customObjects: k8s.CustomObjectsApi;
    private readonly core: k8s.CoreV1Api;
    private readonly apps: k8s.AppsV1Api;
    private readonly batch: k8s.BatchV1Api;
    private readonly networking: k8s.NetworkingV1Api;

    constructor() {
        this.kc = new k8s.KubeConfig();
        this.kc.loadFromDefault(); // in-cluster SA, then kubeconfig.
        this.customObjects = this.kc.makeApiClient(k8s.CustomObjectsApi);
        this.core = this.kc.makeApiClient(k8s.CoreV1Api);
        this.apps = this.kc.makeApiClient(k8s.AppsV1Api);
        this.batch = this.kc.makeApiClient(k8s.BatchV1Api);
        this.networking = this.kc.makeApiClient(k8s.NetworkingV1Api);
    }

    async ensure(namespace: string, object: KubeObject): Promise<string> {
        const name = object.metadata.name;
        const apiVersion = object.apiVersion;
        const [group, version] = apiVersion.split("/");
        const kind = object.kind;
        const body = { ...object, metadata: { ...object.metadata, namespace } };

        try {
            // Create if absent. The controller is level-triggered: if the object
            // already exists we accept it as-is (create-if-absent). Correcting
            // spec drift via strategic-merge patch is a follow-on — the v1.x
            // client's patch content-type handling is awkward, and overwriting
            // immutable fields (bound PVC spec, server-assigned ownerRef uids)
            // is rejected anyway.
            await this.createByKind(namespace, group, version, kind, body);
            return name;
        } catch (error: unknown) {
            if (kubeStatus(error) === 409) return name; // exists
            throw error;
        }
    }

    async delete(namespace: string, kind: string, name: string): Promise<boolean> {
        try {
            await this.deleteByKind(namespace, kind, name);
            return true;
        } catch (error: unknown) {
            if (kubeStatus(error) === 404) return false;
            throw error;
        }
    }

    async patchMetadata(namespace: string, kind: string, name: string, patch: Record<string, unknown>): Promise<void> {
        // Native objects: strategic-merge patch of metadata.
        if (kind === "Deployment") { await this.apps.patchNamespacedDeployment({ name, namespace, body: { metadata: patch } }); return; }
        if (kind === "Service") { await this.core.patchNamespacedService({ name, namespace, body: { metadata: patch } }); return; }
        if (kind === "PersistentVolumeClaim") { await this.core.patchNamespacedPersistentVolumeClaim({ name, namespace, body: { metadata: patch } }); return; }
        if (kind === "CronJob") { await this.batch.patchNamespacedCronJob({ name, namespace, body: { metadata: patch } }); return; }
        if (kind === "NetworkPolicy") { await this.networking.patchNamespacedNetworkPolicy({ name, namespace, body: { metadata: patch } }); return; }
        // Hades CRDs: strategic-merge patch via customObjects.
        const plural = pluralize(kind);
        await this.customObjects.patchNamespacedCustomObject({
            group: "hades.dev", version: "v1alpha1", namespace, plural, name,
            body: { metadata: patch },
        });
    }

    async list(namespace: string, kind: string): Promise<KubeObject[]> {
        const result = await this.listByKind(namespace, kind);
        return (result?.items ?? []) as KubeObject[];
    }

    async get(namespace: string, kind: string, name: string): Promise<KubeObject | undefined> {
        try {
            return await this.getByKind(namespace, kind, name);
        } catch (error: unknown) {
            if (kubeStatus(error) === 404) return undefined;
            throw error;
        }
    }

    async patchStatus(namespace: string, kind: string, name: string, status: Record<string, unknown>): Promise<void> {
        const plural = pluralize(kind);
        const opts = { headers: { "content-type": "application/merge-patch+json" } };
        await this.customObjects.patchNamespacedCustomObjectStatus({
            group: "hades.dev", version: "v1alpha1", namespace, plural, name, body: { status }, ...opts,
        });
    }

    async getSecret(namespace: string, name: string): Promise<Record<string, string> | undefined> {
        try {
            const secret = await this.core.readNamespacedSecret({ name, namespace });
            const data = (secret as { data?: Record<string, string> }).data ?? {};
            // k8s Secret data is base64-encoded; decode it.
            const decoded: Record<string, string> = {};
            for (const [key, value] of Object.entries(data)) {
                decoded[key] = Buffer.from(value, "base64").toString("utf8");
            }
            return decoded;
        } catch (error: any) {
            if (error?.statusCode === 404 || error?.code === 404) return undefined;
            throw error;
        }
    }

    async healthz(): Promise<boolean> {
        try {
            await this.core.listNamespace();
            return true;
        } catch {
            return false;
        }
    }

    async exec(namespace: string, pod: string, container: string, command: string[], stdin?: string): Promise<ExecResult> {
        const exec = new k8s.Exec(this.kc);
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const stdinStream = new PassThrough();
        if (stdin) stdinStream.end(stdin);
        else stdinStream.end();
        let code = 0;
        const done = new Promise<void>((resolve) => {
            exec.exec(namespace, pod, container, command, stdout, stderr, stdinStream, false, (status) => {
                code = status.status === "Success" ? 0 : 1;
                resolve();
            }).then((ws) => {
                ws.on("close", () => resolve());
            }).catch(() => resolve());
        });
        await done;
        return { code, stdout: stdout.read()?.toString() ?? "", stderr: stderr.read()?.toString() ?? "" };
    }

    private async createByKind(ns: string, group: string, version: string, kind: string, body: any): Promise<void> {
        if (kind === "Deployment") return void (await this.apps.createNamespacedDeployment({ namespace: ns, body }));
        if (kind === "Service") return void (await this.core.createNamespacedService({ namespace: ns, body }));
        if (kind === "PersistentVolumeClaim") return void (await this.core.createNamespacedPersistentVolumeClaim({ namespace: ns, body }));
        if (kind === "CronJob") return void (await this.batch.createNamespacedCronJob({ namespace: ns, body }));
        if (kind === "NetworkPolicy") return void (await this.networking.createNamespacedNetworkPolicy({ namespace: ns, body }));
        // Custom resource (Hades CRD or other).
        const plural = pluralize(kind);
        await this.customObjects.createNamespacedCustomObject({ group, version, namespace: ns, plural, body });
    }

    private async deleteByKind(ns: string, kind: string, name: string): Promise<void> {
        if (kind === "Deployment") return void (await this.apps.deleteNamespacedDeployment({ name, namespace: ns }));
        if (kind === "Service") return void (await this.core.deleteNamespacedService({ name, namespace: ns }));
        if (kind === "PersistentVolumeClaim") return void (await this.core.deleteNamespacedPersistentVolumeClaim({ name, namespace: ns }));
        if (kind === "CronJob") return void (await this.batch.deleteNamespacedCronJob({ name, namespace: ns }));
        if (kind === "NetworkPolicy") return void (await this.networking.deleteNamespacedNetworkPolicy({ name, namespace: ns }));
        // Custom resources: need group/version from the object — not available from kind alone.
        // The controller deletes by kind+name for native objects; custom resource deletion
        // is handled via ownerReferences cascade.
        throw new Error(`deleteByKind: cannot delete custom resource ${kind}/${name} without group/version`);
    }

    private async listByKind(ns: string, kind: string): Promise<{ items: any[] } | undefined> {
        if (kind === "Deployment") return await this.apps.listNamespacedDeployment({ namespace: ns });
        if (kind === "Service") return await this.core.listNamespacedService({ namespace: ns });
        if (kind === "PersistentVolumeClaim") return await this.core.listNamespacedPersistentVolumeClaim({ namespace: ns });
        if (kind === "CronJob") return await this.batch.listNamespacedCronJob({ namespace: ns });
        if (kind === "NetworkPolicy") return await this.networking.listNamespacedNetworkPolicy({ namespace: ns });
        return { items: [] };
    }

    private async getByKind(ns: string, kind: string, name: string): Promise<KubeObject> {
        if (kind === "Deployment") return await this.apps.readNamespacedDeployment({ name, namespace: ns }) as unknown as KubeObject;
        if (kind === "Service") return await this.core.readNamespacedService({ name, namespace: ns }) as unknown as KubeObject;
        if (kind === "PersistentVolumeClaim") return await this.core.readNamespacedPersistentVolumeClaim({ name, namespace: ns }) as unknown as KubeObject;
        if (kind === "CronJob") return await this.batch.readNamespacedCronJob({ name, namespace: ns }) as unknown as KubeObject;
        if (kind === "NetworkPolicy") return await this.networking.readNamespacedNetworkPolicy({ name, namespace: ns }) as unknown as KubeObject;
        // Hades CRDs (Agent/Home/Hands/Schedule/...) — read via custom objects.
        const plural = pluralize(kind);
        const resp = await this.customObjects.getNamespacedCustomObject({ group: "hades.dev", version: "v1alpha1", namespace: ns, plural, name });
        return resp as unknown as KubeObject;
    }
}

/** Plural for a Hades kind — must match the CRD `names.plural`. */
const HADES_PLURALS: Record<string, string> = {
    agent: "agents",
    agentclass: "agentclasses",
    home: "homes",
    session: "sessions",
    brainbinding: "brainbindings",
    hands: "hands",
    listener: "listeners",
    schedule: "schedules",
    run: "runs",
    approval: "approvals",
    capabilitygrant: "capabilitygrants",
};

function pluralize(kind: string): string {
    const lower = kind.toLowerCase();
    if (HADES_PLURALS[lower]) return HADES_PLURALS[lower];
    // Native k8s kinds are not pluralized here (handled by typed APIs).
    if (lower.endsWith("s")) return `${lower}es`;
    if (lower.endsWith("y")) return `${lower.slice(0, -1)}ies`;
    return `${lower}s`;
}

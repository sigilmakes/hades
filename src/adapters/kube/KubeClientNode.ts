import * as k8s from "@kubernetes/client-node";
import type { KubeClient, KubeObject } from "../../ports/KubeClient.js";

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
            // Try create; if it exists (409), patch.
            await this.createByKind(namespace, group, version, kind, body);
            return name;
        } catch (error: any) {
            if (error?.statusCode === 409 || error?.code === 409) {
                await this.replaceByKind(namespace, group, version, kind, name, body);
                return name;
            }
            throw error;
        }
    }

    async delete(namespace: string, kind: string, name: string): Promise<boolean> {
        try {
            await this.deleteByKind(namespace, kind, name);
            return true;
        } catch (error: any) {
            if (error?.statusCode === 404 || error?.code === 404) return false;
            throw error;
        }
    }

    async list(namespace: string, kind: string): Promise<KubeObject[]> {
        // Generic list across the kinds the controller creates. For simplicity,
        // lists one kind at a time; the controller uses this for idempotency checks.
        const result = await this.listByKind(namespace, kind);
        return (result?.items ?? []) as KubeObject[];
    }

    async healthz(): Promise<boolean> {
        try {
            await this.core.listNamespace();
            return true;
        } catch {
            return false;
        }
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

    private async replaceByKind(ns: string, group: string, version: string, kind: string, name: string, body: any): Promise<void> {
        if (kind === "Deployment") return void (await this.apps.replaceNamespacedDeployment({ name, namespace: ns, body }));
        if (kind === "Service") return void (await this.core.replaceNamespacedService({ name, namespace: ns, body }));
        if (kind === "PersistentVolumeClaim") return void (await this.core.replaceNamespacedPersistentVolumeClaim({ name, namespace: ns, body }));
        if (kind === "CronJob") return void (await this.batch.replaceNamespacedCronJob({ name, namespace: ns, body }));
        if (kind === "NetworkPolicy") return void (await this.networking.replaceNamespacedNetworkPolicy({ name, namespace: ns, body }));
        const plural = pluralize(kind);
        await this.customObjects.replaceNamespacedCustomObject({ group, version, namespace: ns, plural, name, body });
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
}

function pluralize(kind: string): string {
    const lower = kind.toLowerCase();
    if (lower.endsWith("s")) return `${lower}es`;
    if (lower.endsWith("y")) return `${lower.slice(0, -1)}ies`;
    return `${lower}s`;
}

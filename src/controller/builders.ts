import { nameOf, namespaceOf, type HadesResource } from "../domain/resources.js";
import { hadesLabels, HADES_FINALIZER, type KubeObject } from "../ports/KubeClient.js";

/** A resolved owner reference (cluster uid included) or undefined. */
export type OwnerRef = { apiVersion: string; kind: string; name: string; uid: string; blockOwnerDeletion: boolean; controller: boolean };

/** Build a `PersistentVolumeClaim` for a Home. StorageClass left to the cluster default. */
export function buildHomePvc(home: HadesResource): KubeObject {
    const name = nameOf(home);
    return {
        apiVersion: "v1",
        kind: "PersistentVolumeClaim",
        metadata: { name: `home-${name}`, namespace: namespaceOf(home), labels: hadesLabels(home) },
        spec: {
            accessModes: ["ReadWriteOnce"],
            resources: { requests: { storage: home.spec?.size ?? "1Gi" } },
            // storageClassName intentionally unset → cluster default applies.
        },
    };
}

/** Build the brain `Deployment` + `Service` for an active agent. */
export function buildBrain(agent: HadesResource, ownerRefs?: OwnerRef[]): { deployment: KubeObject; service: KubeObject } {
    const name = nameOf(agent);
    const ns = namespaceOf(agent);
    const secretRef = agent.spec?.brain?.secretRef;
    const brainEnv = [
        { name: "HADES_SESSION_ID", value: agent.spec?.defaultSession ?? `${name}-default` },
        // The brain execs into the hands pod via the in-cluster k8s API.
        { name: "HADES_AGENT_NAME", value: name },
        { name: "HADES_AGENT_NAMESPACE", value: ns },
    ];
    const deployment: KubeObject = {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: `brain-${name}`, namespace: ns, labels: hadesLabels(agent), ownerReferences: ownerRefs },
        spec: {
            replicas: 1,
            selector: { matchLabels: { "hades.dev/agent": name } },
            template: {
                metadata: { labels: { "hades.dev/agent": name, "hades.dev/role": "brain" } },
                spec: {
                    // The brain execs into hands pods via this SA (pods/exec only).
                    serviceAccountName: "hades-brain",
                    containers: [{
                        name: "brain",
                        image: agent.spec?.brain?.image ?? "hades-brain:latest",
                        imagePullPolicy: "Never",
                        ports: [{ containerPort: 7349, name: "http" }],
                        env: brainEnv,
                        // Model credentials are mounted as a Secret envFrom, never into hands.
                        ...(secretRef ? { envFrom: [{ secretRef: { name: secretRef } }] } : {}),
                        readinessProbe: { httpGet: { path: "/healthz", port: 7349 }, initialDelaySeconds: 3, periodSeconds: 5 },
                        livenessProbe: { httpGet: { path: "/healthz", port: 7349 }, initialDelaySeconds: 30, periodSeconds: 30, failureThreshold: 5 },
                    }],
                },
            },
        },
    };
    const service: KubeObject = {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: `brain-${name}`, namespace: ns, labels: hadesLabels(agent), ownerReferences: ownerRefs },
        spec: { selector: { "hades.dev/agent": name }, ports: [{ port: 80, targetPort: 7349 }] },
    };
    return { deployment, service };
}

/** Build the hands `Deployment` (sleep-infinity sandbox) + its `NetworkPolicy`. */
export function buildHands(hands: HadesResource, agent: HadesResource | undefined, ownerRefs: OwnerRef[] | undefined, egress: Record<string, unknown>[]): { deployment: KubeObject; networkPolicy: KubeObject } {
    const ns = namespaceOf(hands);
    const name = nameOf(hands);
    const agentName = hands.spec?.agentRef ?? name.replace(/-home-shell$/, "");
    // Resolve the home PVC claim: prefer the Hands spec homeRef, then the agent's homeRef,
    // then the convention. The PVC is named home-<homeName>.
    const homeName = hands.spec?.homeRef ?? agent?.spec?.homeRef ?? `${agentName}-home`;
    const homeClaim = `home-${homeName}`;
    const deployment: KubeObject = {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: `hands-${agentName}`, namespace: ns, labels: hadesLabels(hands), ownerReferences: ownerRefs },
        spec: {
            replicas: 1,
            selector: { matchLabels: { "hades.dev/agent": agentName, "hades.dev/role": "hands" } },
            template: {
                metadata: { labels: { "hades.dev/agent": agentName, "hades.dev/role": "hands" } },
                spec: {
                    // Hands pods must not be able to call back into the k8s API.
                    automountServiceAccountToken: false,
                    containers: [{
                        name: "hands",
                        image: hands.spec?.image ?? "node:24-slim",
                        imagePullPolicy: "IfNotPresent",
                        // The hands pod is a thin sandbox: sleep infinity. The brain
                        // execs read/write/exec into it via the k8s API. No server, no port.
                        command: ["sleep", "infinity"],
                        env: [{ name: "HADES_HOME_ROOT", value: "/home/agent" }],
                        volumeMounts: [{ name: "home", mountPath: "/home/agent" }],
                        // Liveness: confirm the home mount is present (exec-based, no server).
                        livenessProbe: { exec: { command: ["test", "-d", "/home/agent"] }, initialDelaySeconds: 5, periodSeconds: 30 },
                    }],
                    volumes: [{ name: "home", persistentVolumeClaim: { claimName: homeClaim } }],
                },
            },
        },
    };
    // No Service: the brain reaches the hands pod via k8s exec (in-cluster SA),
    // not over HTTP. The NetworkPolicy isolates the pod.
    const networkPolicy: KubeObject = {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: `hands-${agentName}-netpol`, namespace: ns, labels: hadesLabels(hands), ownerReferences: ownerRefs },
        spec: {
            podSelector: { matchLabels: { "hades.dev/agent": agentName, "hades.dev/role": "hands" } },
            policyTypes: ["Ingress", "Egress"],
            // No ingress: the brain reaches hands via k8s exec, not a port. Default-deny.
            ingress: [],
            // Egress is projected from the agent's CapabilityGrants (default-deny).
            egress,
        },
    };
    return { deployment, networkPolicy };
}

/**
 * Compute the egress rules for a hands pod from the agent's grants.
 * Default-deny (no egress). A `networkEgress` capability in a grant's
 * constraints opens the matching profile:
 *   restricted-web -> DNS (kube-dns) + HTTPS (anywhere:443)
 * Anything else -> no egress (default-deny).
 */
export function egressForAgent(grants: HadesResource[], agentName: string): Record<string, unknown>[] {
    const profiles = new Set<string>();
    for (const grant of grants) {
        if (grant.spec?.subject?.kind !== "Agent" || grant.spec?.subject?.name !== agentName) continue;
        for (const cap of grant.spec?.capabilities ?? []) {
            if (cap.startsWith("networkEgress:")) profiles.add(cap.slice("networkEgress:".length));
        }
        const constraintProfiles = grant.spec?.constraints?.networkEgress;
        if (Array.isArray(constraintProfiles)) for (const p of constraintProfiles) profiles.add(p);
    }
    const egress: Record<string, unknown>[] = [];
    if (profiles.has("restricted-web")) {
        // DNS to the kube-dns cluster Service.
        egress.push({ to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } }, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] });
        // HTTPS anywhere.
        egress.push({ to: [{ ipBlock: { cidr: "0.0.0.0/0" } }], ports: [{ protocol: "TCP", port: 443 }] });
    }
    return egress; // empty = default-deny
}

/** Build a `CronJob` for a cron/interval Schedule. */
export function buildSchedule(schedule: HadesResource, cronExpr: string, ownerRefs?: OwnerRef[]): KubeObject {
    const ns = namespaceOf(schedule);
    const name = nameOf(schedule);
    const agentName = schedule.spec?.agentRef ?? "";
    return {
        apiVersion: "batch/v1",
        kind: "CronJob",
        metadata: { name: `sched-${name}`, namespace: ns, labels: hadesLabels(schedule), ownerReferences: ownerRefs },
        spec: {
            schedule: cronExpr,
            jobTemplate: {
                spec: {
                    template: {
                        spec: {
                            containers: [{
                                name: "trigger",
                                image: "hades-api:latest",
                                command: ["node", "dist/cli.js", "say", `${ns}/${agentName}`, schedule.spec?.prompt ?? "scheduled"],
                            }],
                            restartPolicy: "OnFailure",
                        },
                    },
                },
            },
        },
    };
}

/** Build a Hades CRD object from a Hades resource (for ensureHadesResources). */
export function buildHadesCrd(resource: HadesResource): KubeObject {
    const ns = namespaceOf(resource);
    const name = nameOf(resource);
    return {
        apiVersion: "hades.dev/v1alpha1",
        kind: resource.kind,
        metadata: { name, namespace: ns, labels: hadesLabels(resource), finalizers: [HADES_FINALIZER] },
        spec: resource.spec ?? {},
    };
}

/** Convert a Hades schedule spec to a k8s CronJob 5-field cron expression. */
export function toCronExpression(spec: Record<string, unknown> | undefined): string {
    const type = spec?.type;
    const schedule = (spec?.schedule ?? "") as string;
    if (type === "cron") return schedule;
    if (type === "interval") {
        // Hades interval: +Ns/m/h → run every N units.
        const match = schedule.match(/^(\d+)([smh])$/);
        if (!match) throw new Error(`Invalid interval schedule: ${schedule}`);
        const n = Number(match[1]);
        const unit = match[2];
        if (unit === "s") return `*/${n} * * * *`;
        if (unit === "m") return `*/${n} * * * *`;
        if (unit === "h") return `0 */${n} * * *`;
    }
    throw new Error(`Cannot convert schedule type ${type} to cron expression`);
}

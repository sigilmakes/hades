import { nameOf, namespaceOf, type HadesResource } from "../domain/resources.js";
import { hadesLabels, type KubeClient, type KubeObject } from "../ports/KubeClient.js";
import type { StateStorePort } from "../ports/StateStore.js";
import type { EventStorePort } from "../ports/EventStore.js";

/**
 * The deploy-mode controller. Watches Hades resources and reconciles them
 * into native k8s objects via a {@link KubeClient}:
 *
 * - `Agent` (desiredState=active) → brain `Deployment` + `Service`
 * - `Agent` (lifecycle=ephemeral, completed) → cascades brain/hands deletion
 * - `Home` → `PersistentVolumeClaim`
 * - `Hands` → hands `Deployment` (sleep-infinity sandbox; the brain execs into it)
 * - `Schedule` (type=cron/interval) → k8s `CronJob`
 * - `CapabilityGrant` → (logical policy; NetworkPolicy projection is a follow-on)
 *
 * This re-targets the in-process {@link Reconciler} semantics at the k8s API:
 * observe desired state → ensure native objects match → emit event → update
 * status. The reconciliation *logic* is the same; only the *substrate* changes.
 *
 * Status subresource: controllers write `status.phase` back to the resource
 * (`kubectl get agents` shows phase).
 *
 * Uses `ownerReferences` so GC is native k8s: a deleted Agent's brain/hands
 * pods disappear via k8s ownership, not a Hades GC loop.
 */
export class KubeController {
    constructor(
        private readonly state: StateStorePort,
        private readonly events: EventStorePort,
        private readonly kube: KubeClient,
    ) {}

    async reconcile(): Promise<void> {
        for (const home of this.state.list("Home")) await this.reconcileHome(home);
        for (const agent of this.state.list("Agent")) await this.reconcileAgent(agent);
        for (const hands of this.state.list("Hands")) await this.reconcileHands(hands);
        for (const schedule of this.state.list("Schedule")) await this.reconcileSchedule(schedule);
    }

    /** Home → PVC (StorageClass left to the cluster default). */
    async reconcileHome(home: HadesResource): Promise<void> {
        const ns = namespaceOf(home);
        const name = nameOf(home);
        const pvc: KubeObject = {
            apiVersion: "v1",
            kind: "PersistentVolumeClaim",
            metadata: {
                name: `home-${name}`,
                namespace: ns,
                labels: hadesLabels(home),
            },
            spec: {
                accessModes: ["ReadWriteOnce"],
                resources: { requests: { storage: home.spec?.size ?? "1Gi" } },
                // storageClassName intentionally unset → cluster default applies.
            },
        };
        await this.kube.ensure(ns, pvc);
        await this.events.append("system", "home.reconciled", { home: name, pvc: `home-${name}` });
        await this.patchStatus(home, { phase: "ready", pvc: `home-${name}` });
    }

    /** Agent → brain Deployment + Service (when active). Ephemeral completed → cascade. */
    async reconcileAgent(agent: HadesResource): Promise<void> {
        const ns = namespaceOf(agent);
        const name = nameOf(agent);
        const desired = agent.spec?.desiredState ?? "active";
        const lifecycle = agent.spec?.lifecycle ?? "resident";
        const completed = agent.status?.phase === "completed";

        if (lifecycle === "ephemeral" && completed) {
            // Reaped ephemeral: cascade-delete its brain/hands pods (ownerRefs).
            await this.kube.delete(ns, "Deployment", `brain-${name}`);
            await this.kube.delete(ns, "Service", `brain-${name}`);
            await this.kube.delete(ns, "Deployment", `hands-${name}`);
            await this.kube.delete(ns, "Service", `hands-${name}`);
            await this.events.append("system", "agent.cascaded", { agent: name, namespace: ns });
            return;
        }

        if (desired !== "active") {
            await this.patchStatus(agent, { phase: desired });
            return;
        }

        const ownerRef = { apiVersion: "hades.dev/v1alpha1", kind: "Agent", name, blockOwnerDeletion: true, controller: true };
        const secretRef = agent.spec?.brain?.secretRef;
        const brainEnv = [
            { name: "HADES_SESSION_ID", value: agent.spec?.defaultSession ?? `${name}-default` },
            // The brain execs into the hands pod via the in-cluster k8s API.
            // PodHandsBackend resolves the pod name from the agent + namespace.
            { name: "HADES_AGENT_NAME", value: name },
            { name: "HADES_AGENT_NAMESPACE", value: ns },
        ];
        const brain: KubeObject = {
            apiVersion: "apps/v1",
            kind: "Deployment",
            metadata: { name: `brain-${name}`, namespace: ns, labels: hadesLabels(agent), ownerReferences: [ownerRef] },
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
                            ports: [{ containerPort: 7349 }],
                            env: brainEnv,
                            // Model credentials are mounted as a Secret envFrom, never into hands.
                            ...(secretRef ? { envFrom: [{ secretRef: { name: secretRef } }] } : {}),
                        }],
                    },
                },
            },
        };
        const brainSvc: KubeObject = {
            apiVersion: "v1",
            kind: "Service",
            metadata: { name: `brain-${name}`, namespace: ns, labels: hadesLabels(agent), ownerReferences: [ownerRef] },
            spec: { selector: { "hades.dev/agent": name }, ports: [{ port: 80, targetPort: 7349 }] },
        };
        await this.kube.ensure(ns, brain);
        await this.kube.ensure(ns, brainSvc);
        await this.events.append("system", "agent.reconciled", { agent: name, namespace: ns, brain: `brain-${name}` });
        await this.patchStatus(agent, { phase: "active", brainPod: `brain-${name}` });
    }

    /** Hands → Deployment (sleep-infinity sandbox the brain execs into via the k8s API). */
    async reconcileHands(hands: HadesResource): Promise<void> {
        const ns = namespaceOf(hands);
        const name = nameOf(hands);
        const agentName = hands.spec?.agentRef ?? name.replace(/-home-shell$/, "");
        // Skip hands whose agent is a reaped ephemeral — the agent cascade handles deletion.
        const agent = this.state.findByName("Agent", agentName, ns);
        if (agent?.spec?.lifecycle === "ephemeral" && agent?.status?.phase === "completed") {
            return;
        }
        // Resolve the home PVC claim: prefer the Hands spec homeRef, then the agent's homeRef,
        // then the convention. The PVC is named home-<homeName>.
        const homeName = hands.spec?.homeRef ?? agent?.spec?.homeRef ?? `${agentName}-home`;
        const homeClaim = `home-${homeName}`;
        const ownerRef = { apiVersion: "hades.dev/v1alpha1", kind: "Hands", name, blockOwnerDeletion: true, controller: true };
        const handsDep: KubeObject = {
            apiVersion: "apps/v1",
            kind: "Deployment",
            metadata: { name: `hands-${agentName}`, namespace: ns, labels: hadesLabels(hands), ownerReferences: [ownerRef] },
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
                            imagePullPolicy: "Never",
                            // The hands pod is a thin sandbox: sleep infinity. The brain
                            // execs read/write/exec into it via the k8s API. No server, no port.
                            command: ["sleep", "infinity"],
                            env: [{ name: "HADES_HOME_ROOT", value: "/home/agent" }],
                            volumeMounts: [{ name: "home", mountPath: "/home/agent" }],
                        }],
                        volumes: [{ name: "home", persistentVolumeClaim: { claimName: homeClaim } }],
                    },
                },
            },
        };
        // No Service: the brain reaches the hands pod via k8s exec (in-cluster SA),
        // not over HTTP. The NetworkPolicy still isolates the pod.
        // NetworkPolicy: the capability boundary as k8s network policy.
        // brain pod -> hands pod only (exec); hands pod -> nothing (no egress).
        const handsNetPol: KubeObject = {
            apiVersion: "networking.k8s.io/v1",
            kind: "NetworkPolicy",
            metadata: { name: `hands-${agentName}-netpol`, namespace: ns, labels: hadesLabels(hands), ownerReferences: [ownerRef] },
            spec: {
                podSelector: { matchLabels: { "hades.dev/agent": agentName, "hades.dev/role": "hands" } },
                policyTypes: ["Ingress", "Egress"],
                ingress: [
                    // The brain reaches the hands pod via k8s exec (in-cluster SA),
                    // not over a port. No ingress is needed; default-deny.
                ],
                egress: [
                    // Hands pods have no egress by default — no model creds, no internet.
                    // (DNS could be added per-profile if a hands tool needs it; default-deny is safest.)
                ],
            },
        };
        await this.kube.ensure(ns, handsDep);
        await this.kube.ensure(ns, handsNetPol);
        await this.events.append("system", "hands.reconciled", { hands: name, namespace: ns, deployment: `hands-${agentName}` });
        await this.patchStatus(hands, { phase: "ready", podName: `hands-${agentName}` });
    }

    /** Schedule → k8s CronJob (replaces the in-process croner in deploy mode). */
    async reconcileSchedule(schedule: HadesResource): Promise<void> {
        const ns = namespaceOf(schedule);
        const name = nameOf(schedule);
        const type = schedule.spec?.type;
        if (type !== "cron" && type !== "interval") {
            // once schedules are delivered in-process by the kernel; not a CronJob.
            await this.patchStatus(schedule, { phase: schedule.status?.phase ?? "pending" });
            return;
        }
        const cronExpr = toCronExpression(schedule.spec);
        const ownerRef = { apiVersion: "hades.dev/v1alpha1", kind: "Schedule", name, blockOwnerDeletion: true, controller: true };
        const agentName = schedule.spec?.agentRef ?? "";
        const cronJob: KubeObject = {
            apiVersion: "batch/v1",
            kind: "CronJob",
            metadata: { name: `sched-${name}`, namespace: ns, labels: hadesLabels(schedule), ownerReferences: [ownerRef] },
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
        await this.kube.ensure(ns, cronJob);
        await this.events.append("system", "schedule.reconciled", { schedule: name, namespace: ns, cronJob: `sched-${name}` });
        await this.patchStatus(schedule, { phase: "active", cronJob: `sched-${name}` });
    }

    private async patchStatus(resource: HadesResource, status: Record<string, any>): Promise<void> {
        resource.status = { ...(resource.status ?? {}), ...status };
        await this.state.save();
    }
}

/** Convert a Hades schedule spec to a k8s CronJob 5-field cron expression. */
export function toCronExpression(spec: Record<string, any> | undefined): string {
    const type = spec?.type;
    const schedule = spec?.schedule ?? "";
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

import { nameOf, namespaceOf, type HadesResource } from "../domain/resources.js";
import { type KubeClient } from "../ports/KubeClient.js";
import type { StateStorePort } from "../ports/StateStore.js";
import type { EventStorePort } from "../ports/EventStore.js";
import {
    buildHands, buildHomePvc, buildBrain, buildSchedule, buildHadesCrd, egressForAgent, toCronExpression,
    type OwnerRef,
} from "./builders.js";

/**
 * The deploy-mode controller. Watches Hades resources and reconciles them into
 * native k8s objects via a {@link KubeClient}:
 *
 * - `Agent` (desiredState=active) → brain `Deployment` + `Service`
 * - `Agent` (lifecycle=ephemeral, completed) → cascades brain/hands deletion
 * - `Home` → `PersistentVolumeClaim`
 * - `Hands` → hands `Deployment` (sleep-infinity sandbox; the brain execs into it)
 * - `Schedule` (type=cron/interval) → k8s `CronJob`
 *
 * The k8s object *shapes* live in {@link ./builders.ts} (pure functions); this
 * class is the reconcile loop: ensure Hades CRDs exist, then dispatch each
 * resource to its builder and ensure the result. Uses `ownerReferences` so GC
 * is native k8s. Status is written back to the local state mirror.
 */
export class KubeController {
    constructor(
        private readonly state: StateStorePort,
        private readonly events: EventStorePort,
        private readonly kube: KubeClient,
    ) {}

    async reconcile(): Promise<void> {
        // Hades resources must exist as CRDs first so native objects can reference
        // them via ownerReferences (k8s requires a uid).
        await this.ensureHadesResources();
        for (const home of this.state.list("Home")) await this.reconcileHome(home);
        for (const agent of this.state.list("Agent")) await this.reconcileAgent(agent);
        for (const hands of this.state.list("Hands")) await this.reconcileHands(hands);
        for (const schedule of this.state.list("Schedule")) await this.reconcileSchedule(schedule);
    }

    /** Apply every Hades resource in the state store as a CRD (source of truth). */
    private async ensureHadesResources(): Promise<void> {
        for (const kind of HADES_KINDS) {
            for (const resource of this.state.list(kind)) {
                const ns = namespaceOf(resource);
                const name = nameOf(resource);
                const existing = await this.kube.get(ns, kind, name);
                if (existing?.metadata?.uid) continue;
                await this.kube.ensure(ns, buildHadesCrd(resource));
            }
        }
    }

    /** Resolve a Hades resource's cluster uid into an ownerReference (or undefined). */
    private async ownerRefOf(resource: HadesResource): Promise<OwnerRef | undefined> {
        const ns = namespaceOf(resource);
        const name = nameOf(resource);
        const existing = await this.kube.get(ns, resource.kind, name);
        const uid = existing?.metadata?.uid;
        if (!uid) return undefined;
        return { apiVersion: "hades.dev/v1alpha1", kind: resource.kind, name, uid, blockOwnerDeletion: true, controller: true };
    }

    /** Home → PVC. */
    async reconcileHome(home: HadesResource): Promise<void> {
        const name = nameOf(home);
        await this.kube.ensure(namespaceOf(home), buildHomePvc(home));
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

        const ownerRefs = await this.ownerRefs(agent);
        const { deployment, service } = buildBrain(agent, ownerRefs);
        await this.kube.ensure(ns, deployment);
        await this.kube.ensure(ns, service);
        await this.events.append("system", "agent.reconciled", { agent: name, namespace: ns, brain: `brain-${name}` });
        await this.patchStatus(agent, { phase: "active", brainPod: `brain-${name}` });
    }

    /** Hands → Deployment (sleep-infinity sandbox) + NetworkPolicy. */
    async reconcileHands(hands: HadesResource): Promise<void> {
        const ns = namespaceOf(hands);
        const name = nameOf(hands);
        const agentName = hands.spec?.agentRef ?? name.replace(/-home-shell$/, "");
        // Skip hands whose agent is a reaped ephemeral — the agent cascade handles deletion.
        const agent = this.state.findByName("Agent", agentName, ns);
        if (agent?.spec?.lifecycle === "ephemeral" && agent?.status?.phase === "completed") return;

        const ownerRefs = await this.ownerRefs(hands);
        const egress = egressForAgent(this.state.list("CapabilityGrant", ns), agentName);
        const { deployment, networkPolicy } = buildHands(hands, agent, ownerRefs, egress);
        await this.kube.ensure(ns, deployment);
        await this.kube.ensure(ns, networkPolicy);
        await this.events.append("system", "hands.reconciled", { hands: name, namespace: ns, deployment: `hands-${agentName}` });
        await this.patchStatus(hands, { phase: "ready", podName: `hands-${agentName}` });
    }

    /** Schedule → CronJob (cron/interval only; `once` is delivered in-process). */
    async reconcileSchedule(schedule: HadesResource): Promise<void> {
        const type = schedule.spec?.type;
        if (type !== "cron" && type !== "interval") {
            await this.patchStatus(schedule, { phase: schedule.status?.phase ?? "pending" });
            return;
        }
        const cronExpr = toCronExpression(schedule.spec as Record<string, unknown>);
        const ownerRefs = await this.ownerRefs(schedule);
        const cronJob = buildSchedule(schedule, cronExpr, ownerRefs);
        const ns = namespaceOf(schedule);
        const name = nameOf(schedule);
        await this.kube.ensure(ns, cronJob);
        await this.events.append("system", "schedule.reconciled", { schedule: name, namespace: ns, cronJob: `sched-${name}` });
        await this.patchStatus(schedule, { phase: "active", cronJob: `sched-${name}` });
    }

    private async ownerRefs(resource: HadesResource): Promise<OwnerRef[] | undefined> {
        const ref = await this.ownerRefOf(resource);
        return ref ? [ref] : undefined;
    }

    private async patchStatus(resource: HadesResource, status: Record<string, unknown>): Promise<void> {
        // Update the local state mirror (always) + the cluster CRD status subresource
        // (best-effort: if the CRD isn't applied yet, the local mirror still holds it).
        resource.status = { ...(resource.status ?? {}), ...status };
        await this.state.save();
        try {
            await this.kube.patchStatus(namespaceOf(resource), resource.kind, nameOf(resource), resource.status);
        } catch {
            // The CRD may not exist yet (ensureHadesResources runs next pass); the local
            // mirror is the fallback. kubectl get agents shows the cluster status once it lands.
        }
    }
}

const HADES_KINDS = ["Agent", "Home", "Hands", "Session", "BrainBinding", "Listener", "Schedule", "Run", "Approval", "CapabilityGrant", "AgentClass"] as const;

export { toCronExpression };

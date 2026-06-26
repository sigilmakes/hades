import { nameOf, namespaceOf, type HadesResource } from "../domain/resources.js";
import { HADES_FINALIZER, type KubeClient } from "../ports/KubeClient.js";
import type { StateStorePort } from "../ports/StateStore.js";
import type { EventStorePort } from "../ports/EventStore.js";
import {
    buildHands, buildHomePvc, buildBrain, buildSchedule, buildHadesCrd, buildConnectorNetworkPolicy, buildHandsImageJob, buildSkillService, egressForAgent, toCronExpression,
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
    private debounce: ReturnType<typeof setTimeout> | undefined;
    private running = false;
    private stopWatch?: () => void;

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
        // Hands images are built before hands pods so the tag resolves this pass.
        for (const image of this.state.list("HandsImage")) await this.reconcileHandsImage(image);
        for (const skill of this.state.list("Skill")) await this.reconcileSkill(skill);
        for (const hands of this.state.list("Hands")) await this.reconcileHands(hands);
        for (const listener of this.state.list("Listener")) await this.reconcileListener(listener);
        for (const schedule of this.state.list("Schedule")) await this.reconcileSchedule(schedule);
        for (const connector of this.state.list("Connector")) await this.reconcileConnector(connector);
    }

    /**
     * Start an event-driven reconcile loop. Subscribes to {@link StateStorePort}
     * mutations and reconciles on change (debounced); the optional `resyncMs`
     * interval is a periodic safety net that re-reconciles the whole store to
     * correct any drift the change stream missed (e.g. external edits to the
     * cluster). Returns a `stop()` that tears down both the watch and the
     * resync timer.
     */
    start(resyncMs = 30_000): () => void {
        if (this.stopWatch) return this.stopWatch;
        // Event-driven: a state mutation schedules a debounced reconcile.
        if (this.state.subscribe) {
            this.stopWatch = this.state.subscribe(() => this.scheduleReconcile());
        }
        // Safety net: periodic full resync catches drift the change stream misses.
        const timer = setInterval(() => this.scheduleReconcile(), resyncMs);
        timer.unref?.();
        return () => {
            this.stopWatch?.();
            this.stopWatch = undefined;
            clearInterval(timer);
            if (this.debounce) { clearTimeout(this.debounce); this.debounce = undefined; }
        };
    }

    /** Schedule a reconcile shortly, coalescing a burst of mutations into one. */
    private scheduleReconcile(): void {
        if (this.running) return; // an in-flight reconcile will observe this change on its next pass
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
            this.debounce = undefined;
            this.running = true;
            this.reconcile()
                .catch((error) => console.error(`reconcile failed: ${error instanceof Error ? error.message : error}`))
                .finally(() => { this.running = false; });
        }, 250);
    }

    /**
     * Apply every Hades resource in the state store as a CRD. The controller is
     * the source of truth for desired state; native objects reference these by
     * uid, so they must exist in the cluster before reconciliation.
     */
    private async ensureHadesResources(): Promise<void> {
        for (const kind of HADES_KINDS) {
            for (const resource of this.state.list(kind)) {
                const ns = namespaceOf(resource);
                const name = nameOf(resource);
                const existing = await this.kube.get(ns, kind, name);
                if (existing?.metadata?.uid) {
                    // Already exists: if it's being deleted, finalize; otherwise ensure the finalizer.
                    if (existing.metadata.deletionTimestamp) {
                        await this.finalizeResource(ns, kind, name);
                    } else if (!existing.metadata.finalizers?.includes(HADES_FINALIZER)) {
                        await this.kube.patchMetadata(ns, kind, name, { finalizers: [HADES_FINALIZER] });
                    }
                    continue;
                }
                await this.kube.ensure(ns, buildHadesCrd(resource));
            }
        }
    }

    /**
     * Finalize a Hades CRD that k8s is deleting (deletionTimestamp set). Runs
     * cleanup that needs the object to still exist, then removes the finalizer
     * so k8s completes the deletion. ownerReferences cascade most native
     * objects, but explicit deletion survives missing refs and records an event.
     */
    private async finalizeResource(namespace: string, kind: string, name: string): Promise<void> {
        if (kind === "Agent") {
            await this.kube.delete(namespace, "Deployment", `brain-${name}`);
            await this.kube.delete(namespace, "Service", `brain-${name}`);
            await this.kube.delete(namespace, "Deployment", `hands-${name}`);
            await this.kube.delete(namespace, "Service", `hands-${name}`);
        } else if (kind === "Home") {
            await this.kube.delete(namespace, "PersistentVolumeClaim", `home-${name}`);
        }
        await this.events.append("system", `${kind.toLowerCase()}.finalized`, { kind, name, namespace });
        await this.kube.patchMetadata(namespace, kind, name, { finalizers: [] });
    }

    /** True if the CRD has a deletionTimestamp (k8s is deleting it; finalize runs). */
    private async isDeleting(namespace: string, kind: string, name: string): Promise<boolean> {
        const existing = await this.kube.get(namespace, kind, name);
        return Boolean(existing?.metadata?.deletionTimestamp);
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
        if (await this.isDeleting(namespaceOf(home), "Home", name)) return;
        await this.kube.ensure(namespaceOf(home), buildHomePvc(home));
        await this.events.append("system", "home.reconciled", { home: name, pvc: `home-${name}` });
        await this.patchStatus(home, { phase: "ready", pvc: `home-${name}` });
    }

    /** Agent → brain Deployment + Service (when active). Ephemeral completed → cascade. */
    async reconcileAgent(agent: HadesResource): Promise<void> {
        const ns = namespaceOf(agent);
        const name = nameOf(agent);
        if (await this.isDeleting(ns, "Agent", name)) return;
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
        // Discover the agent's connectors so the brain pod receives its allowed
        // HTTP endpoints as env (the kernel routes; the brain calls).
        const connectors = this.state.list("Connector", ns).filter((c) => c.spec?.agentRef === nameOf(agent));
        const { deployment, service } = buildBrain(agent, ownerRefs, connectors);
        await this.kube.ensure(ns, deployment);
        await this.kube.ensure(ns, service);
        await this.events.append("system", "agent.reconciled", { agent: name, namespace: ns, brain: `brain-${name}` });
        await this.patchStatus(agent, { phase: "active", brainPod: `brain-${name}` });
    }

    /** Hands → Deployment (sleep-infinity sandbox) + NetworkPolicy. */
    async reconcileHands(hands: HadesResource): Promise<void> {
        const ns = namespaceOf(hands);
        const name = nameOf(hands);
        if (await this.isDeleting(ns, "Hands", name)) return;
        const agentName = hands.spec?.agentRef ?? name.replace(/-home-shell$/, "");
        // Skip hands whose agent is being deleted — the agent's finalize cleans up its brain+hands.
        if (agentName && await this.isDeleting(ns, "Agent", agentName)) return;
        // Skip hands whose agent is a reaped ephemeral — the agent cascade handles deletion.
        const agent = this.state.findByName("Agent", agentName, ns);
        if (agent?.spec?.lifecycle === "ephemeral" && agent?.status?.phase === "completed") return;

        const ownerRefs = await this.ownerRefs(hands);
        const egress = egressForAgent(this.state.list("CapabilityGrant", ns), agentName);
        // Resolve a referenced HandsImage tag if declared on the Hands or its
        // agent, so the hands pod runs the agent's own (nix-built) image.
        const imageRef = hands.spec?.handsImageRef ?? agent?.spec?.handsImageRef;
        const handsImage = imageRef ? this.state.findByName("HandsImage", imageRef, ns) : undefined;
        const resolvedImage = handsImage?.status?.tag;
        const { deployment, networkPolicy } = buildHands(hands, agent, ownerRefs, egress, resolvedImage);
        await this.kube.ensure(ns, deployment);
        await this.kube.ensure(ns, networkPolicy);
        await this.events.append("system", "hands.reconciled", { hands: name, namespace: ns, deployment: `hands-${agentName}` });
        await this.patchStatus(hands, { phase: "ready", podName: `hands-${agentName}` });
    }

    /** Listener → resolve secretRef → construct the bridge; mark connected/failed. */
    async reconcileListener(listener: HadesResource): Promise<void> {
        const ns = namespaceOf(listener);
        const name = nameOf(listener);
        const platform = listener.spec?.platform ?? "cli";
        const secretRef = listener.spec?.secretRef;
        let credentials: Record<string, string> | undefined;
        if (secretRef) {
            credentials = await this.kube.getSecret(ns, secretRef);
            if (!credentials) {
                await this.patchStatus(listener, { phase: "waitingForSecret" });
                await this.events.append("system", "listener.waiting", { listener: name, platform, reason: `secret ${secretRef} not found` });
                return;
            }
        }
        // The bridge is constructed lazily (bridgeForListener) by whoever drives
        // inbound messages; the controller's job here is to confirm the secret
        // resolves and mark the listener ready.
        await this.patchStatus(listener, { phase: "connected", credentials: Boolean(credentials) });
        await this.events.append("system", "listener.reconciled", { listener: name, platform, hasSecret: Boolean(credentials) });
    }

    /**
     * Connector → egress NetworkPolicy (governance) + brain-env discovery.
     *
     * The kernel does not interpret the endpoint body — it only permits the
     * route (NetworkPolicy to the endpoint host:443) and writes status. The
     * brain learns the endpoint via env (handled at pod-apply time from the
     * agent's connector list); here we ensure the network grant exists.
     */
    async reconcileConnector(connector: HadesResource): Promise<void> {
        const ns = namespaceOf(connector);
        const name = nameOf(connector);
        if (await this.isDeleting(ns, "Connector", name)) return;
        const ownerRef = await this.ownerRefOf(connector);
        const policy = buildConnectorNetworkPolicy(connector, ownerRef ? [ownerRef] : undefined);
        let reachable = false;
        if (policy) {
            await this.kube.ensure(ns, policy);
            reachable = true;
        }
        await this.patchStatus(connector, { phase: "ready", reachable });
        await this.events.append("system", "connector.reconciled", { connector: name, agent: String(connector.spec?.agentRef ?? ""), egress: connector.spec?.egress ?? "none", reachable });
    }

    /**
     * HandsImage → a build `Job` that materializes the agent's package
     * declaration into a hands image tag. The kernel schedules the build
     * (idempotent per package digest); the builder image (userland) does the
     * nix work. On completion the controller writes the tag to status so
     * Hands pods referencing it roll forward. The agent owns its packages
     * without touching the host.
     */
    async reconcileHandsImage(image: HadesResource): Promise<void> {
        const ns = namespaceOf(image);
        const name = nameOf(image);
        if (await this.isDeleting(ns, "HandsImage", name)) return;
        const ownerRef = await this.ownerRefOf(image);
        const job = buildHandsImageJob(image, ownerRef ? [ownerRef] : undefined);
        // Idempotent: only create the build Job if it doesn't already exist.
        const existing = await this.kube.get(ns, "Job", job.metadata.name);
        if (!existing) {
            await this.kube.ensure(ns, job);
            await this.events.append("system", "handsimage.building", { image: name, packages: image.spec?.packages ?? [] });
        }
        const phase = existing?.status?.succeeded ? "built" : "building";
        await this.patchStatus(image, { phase, tag: `hands-${name}:${String(job.metadata.name).split("-").pop()}` });
    }

    /**
     * Skill → a `Service` exposing the agent's published HTTP capability.
     * Symmetric with a Connector: the agent *exposes* an endpoint other agents
     * call. The kernel wires the Service to the brain pod; the handler is
     * userland (the agent implements the route). Status carries the cluster URL.
     */
    async reconcileSkill(skill: HadesResource): Promise<void> {
        const ns = namespaceOf(skill);
        const name = nameOf(skill);
        if (await this.isDeleting(ns, "Skill", name)) return;
        const ownerRef = await this.ownerRefOf(skill);
        const svc = buildSkillService(skill, ownerRef ? [ownerRef] : undefined);
        await this.kube.ensure(ns, svc);
        await this.patchStatus(skill, { phase: "exposed", endpoint: `http://skill-${name}.${ns}.svc.cluster.local:${svc.spec.ports[0].port}` });
        await this.events.append("system", "skill.exposed", { skill: name, agent: String(skill.spec?.agentRef ?? ""), endpoint: svc.spec.ports[0].port });
    }

    /** Schedule → k8s CronJob (replaces the in-process croner in deploy mode). */
    async reconcileSchedule(schedule: HadesResource): Promise<void> {
        if (await this.isDeleting(namespaceOf(schedule), "Schedule", nameOf(schedule))) return;
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

const HADES_KINDS = ["Agent", "Home", "Hands", "Session", "BrainBinding", "Listener", "Schedule", "Run", "Approval", "CapabilityGrant", "AgentClass", "Connector", "NamespaceQuota", "HandsImage", "Skill"] as const;

export { toCronExpression };

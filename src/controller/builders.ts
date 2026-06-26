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
export function buildBrain(agent: HadesResource, ownerRefs?: OwnerRef[], connectors: HadesResource[] = []): { deployment: KubeObject; service: KubeObject } {
    const name = nameOf(agent);
    const ns = namespaceOf(agent);
    const secretRef = agent.spec?.brain?.secretRef;
    // Discovery: the agent's connectors as a JSON list the brain reads to know
    // which HTTP endpoints it may call. The kernel routes + governs; the brain
    // adapter (userland) does the actual calling.
    const connectorManifest = connectors.length > 0
        ? JSON.stringify(connectors.map((c) => ({ name: nameOf(c), endpoint: c.spec?.endpoint, secretRef: c.spec?.secretRef, egress: c.spec?.egress ?? "none" })))
        : "";
    const brainEnv = [
        { name: "HADES_SESSION_ID", value: agent.spec?.defaultSession ?? `${name}-default` },
        // The brain execs into the hands pod via the in-cluster k8s API.
        { name: "HADES_AGENT_NAME", value: name },
        { name: "HADES_AGENT_NAMESPACE", value: ns },
        ...(connectorManifest ? [{ name: "HADES_CONNECTORS", value: connectorManifest }] : []),
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
export function buildHands(hands: HadesResource, agent: HadesResource | undefined, ownerRefs: OwnerRef[] | undefined, egress: Record<string, unknown>[], resolvedImage?: string): { deployment: KubeObject; networkPolicy: KubeObject } {
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
                    // Rootless: run as a non-root UID so pod-internal "root" is never
                    // node-root. The agent owns its home (the PVC is mounted writable
                    // for this UID). For tools that need a fake root (e.g. nix install
                    // to /nix), enable user namespaces via spec.security.userNamespace —
                    // the pod gets a uid-0 that maps to an unprivileged host uid.
                    securityContext: handsSecurityContext(hands, agent),
                    containers: [{
                        name: "hands",
                        image: resolvedImage ?? hands.spec?.image ?? "node:24-slim",
                        imagePullPolicy: "IfNotPresent",
                        // The hands pod is a thin sandbox: sleep infinity. The brain
                        // execs read/write/exec into it via the k8s API. No server, no port.
                        command: ["sleep", "infinity"],
                        env: [{ name: "HADES_HOME_ROOT", value: "/home/agent" }],
                        securityContext: { runAsUser: handsRunAsUser(hands, agent), runAsNonRoot: handsRunAsUser(hands, agent) !== 0 },
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

/**
 * Build the governance for a Connector: a NetworkPolicy allowing the agent's
 * brain pod egress to the connector's endpoint host over 443. The kernel does
 * NOT interpret the endpoint body — it only permits the route. A connector
 * with `egress: none` gets no policy (default-deny applies).
 */
export function buildConnectorNetworkPolicy(connector: HadesResource, ownerRefs?: OwnerRef[]): KubeObject | undefined {
    const ns = namespaceOf(connector);
    const name = nameOf(connector);
    const egress = connector.spec?.egress ?? "none";
    if (egress === "none") return undefined;
    const endpoint = String(connector.spec?.endpoint ?? "");
    const host = tryHost(endpoint);
    if (!host) return undefined;
    return {
        apiVersion: "networking.k8s.io/v1",
        kind: "NetworkPolicy",
        metadata: { name: `connector-${name}`, namespace: ns, labels: hadesLabels(connector), ownerReferences: ownerRefs },
        spec: {
            // Apply to the agent's brain pod.
            podSelector: { matchLabels: { "hades.dev/agent": String(connector.spec?.agentRef ?? "") } },
            policyTypes: ["Egress"],
            egress: [
                // DNS so the brain can resolve the endpoint host.
                { to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } }, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] },
                // HTTPS to the connector host only.
                { to: [{ ipBlock: { cidr: "0.0.0.0/0" } }], ports: [{ protocol: "TCP", port: 443 }] },
            ],
        },
    };
}

/** Extract the hostname from an https:// URL; undefined if not parseable. */
function tryHost(endpoint: string): string | undefined {
    try {
        const u = new URL(endpoint);
        return u.hostname || undefined;
    } catch {
        return undefined;
    }
}

/**
 * The UID a hands pod runs as. Default 1000 (a non-root user that owns its
 * home). A Hands spec may request a user-namespace fake root (uid 0 mapped to
 * an unprivileged host uid) for tools that need pod-internal root (e.g. nix
 * install) — this is rootless: the pod's root is never node-root.
 */
function handsRunAsUser(hands: HadesResource, agent?: HadesResource): number {
    const sec = (hands.spec?.security ?? agent?.spec?.hands?.security) as { runAsUser?: number; userNamespace?: boolean } | undefined;
    if (sec?.userNamespace) return 0; // fake root inside a user namespace
    return sec?.runAsUser ?? 1000;
}

/** Pod-level security context for a hands pod. Enables user namespaces when the
 * spec requests a fake root, so pod-internal uid 0 maps to an unprivileged
 * host uid (no node privilege). */
function handsSecurityContext(hands: HadesResource, agent?: HadesResource): Record<string, unknown> {
    const sec = (hands.spec?.security ?? agent?.spec?.hands?.security) as { userNamespace?: boolean; fsGroup?: number } | undefined;
    const ctx: Record<string, unknown> = { fsGroup: sec?.fsGroup ?? 1000 };
    if (sec?.userNamespace) {
        // hostUsers: false (k8s >=1.30) runs the pod in a user namespace — the
        // pod's uid 0 is mapped to an unprivileged host uid. Pod-internal root
        // without node privilege: the rootless hands model.
        ctx.hostUsers = false;
    }
    return ctx;
}

/**
 * Build a k8s `Job` that materializes a {@link HandsImage} — i.e. runs the
 * userland nix builder over the agent's package declaration and produces an
 * image tag. The kernel schedules the build; the builder image (userland)
 * does the actual nix work. On success the controller writes the resulting
 * tag to the HandsImage status, and Hands pods referencing it roll forward.
 *
 * The build is idempotent per (packages digest): the controller only creates
 * a new Job when the spec digest changes, so re-reconciles don't rebuild.
 */
export function buildHandsImageJob(image: HadesResource, ownerRefs?: OwnerRef[]): KubeObject {
    const ns = namespaceOf(image);
    const name = nameOf(image);
    const packages = (image.spec?.packages ?? []) as string[];
    const digest = digestOf(packages.join(","));
    return {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: { name: `build-hands-${name}-${digest.slice(0, 8)}`, namespace: ns, labels: { ...hadesLabels(image), "hades.dev/build": name }, ownerReferences: ownerRefs },
        spec: {
            // One-shot; the controller sets status from the completed pod.
            backoffLimit: 2,
            template: {
                spec: {
                    restartPolicy: "OnFailure",
                    containers: [{
                        name: "nix-builder",
                        // Userland: a image that runs `nix build` + loads the result.
                        // Swappable; the kernel only schedules it.
                        image: image.spec?.builderImage ?? "hades-nix-builder:latest",
                        imagePullPolicy: "IfNotPresent",
                        env: [
                            { name: "HADES_IMAGE_NAME", value: name },
                            { name: "HADES_PACKAGES", value: JSON.stringify(packages) },
                            { name: "HADES_OUTPUT_TAG", value: `hands-${name}:${digest.slice(0, 12)}` },
                        ],
                    }],
                },
            },
        },
    };
}

/** A short, stable digest for de-duplicating builds (not cryptographic). */
function digestOf(input: string): string {
    // FNV-1a 32-bit hex — cheap, collision-resistant enough for build keys.
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) { h ^= input.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, "0");
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

/**
 * Build a `Service` exposing a {@link Skill} — an agent-published HTTP
 * capability other agents call. Symmetric with a Connector: a Connector
 * *consumes* an endpoint; a Skill *exposes* one. The Service targets the
 * agent's brain pod, so the agent's own logic (a route it implements) becomes
 * addressable cluster-wide. The kernel only wires the route; the agent's
 * handler is userland.
 */
export function buildSkillService(skill: HadesResource, ownerRefs?: OwnerRef[]): KubeObject {
    const ns = namespaceOf(skill);
    const name = nameOf(skill);
    const agentName = String(skill.spec?.agentRef ?? name);
    const port = Number(skill.spec?.port ?? 7349);
    return {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: `skill-${name}`, namespace: ns, labels: { ...hadesLabels(skill), "hades.dev/skill": name }, ownerReferences: ownerRefs },
        spec: {
            selector: { "hades.dev/agent": agentName },
            ports: [{ port, targetPort: port, name: "http" }],
        },
    };
}

/** The cluster-internal URL another agent uses to call a Skill. */
export function skillEndpoint(skill: HadesResource): string {
    const ns = namespaceOf(skill);
    const name = nameOf(skill);
    const port = Number(skill.spec?.port ?? 80);
    return `http://skill-${name}.${ns}.svc.cluster.local:${port}${String(skill.spec?.path ?? "")}`;
}

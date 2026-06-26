import path from "node:path";
import { nameOf, namespaceOf, type HadesResource } from "../domain/resources.js";
import type { EventStorePort } from "../ports/EventStore.js";
import type { StateStorePort } from "../ports/StateStore.js";

export class AgentService {
    constructor(
        private readonly dataDir: string,
        private readonly state: StateStorePort,
        private readonly events: EventStorePort,
    ) {}

    async reconcileAgents(): Promise<void> {
        for (const agent of this.state.list("Agent")) await this.reconcileAgent(agent);
    }

    async reconcileAgent(agent: HadesResource): Promise<void> {
        const namespace = namespaceOf(agent);
        const agentName = nameOf(agent);
        // Ephemeral agents are reaped after their one-shot run; do not re-activate them.
        if (agent.spec?.lifecycle === "ephemeral" && agent.status?.phase === "completed") return;
        const sessionName = agent.spec?.defaultSession ?? `${agentName}-default`;
        if (!this.state.findByName("Session", sessionName, namespace)) {
            await this.state.apply({
                apiVersion: "hades.dev/v1alpha1",
                kind: "Session",
                metadata: { namespace, name: sessionName },
                spec: { agentRef: agentName, logRef: sessionName },
                status: { phase: "idle" },
            });
            await this.events.append(sessionName, "session.created", { agent: agentName });
        }
        if (agent.spec?.desiredState === "active" && !this.state.findByName("BrainBinding", `${agentName}-default`, namespace)) {
            await this.state.apply({
                apiVersion: "hades.dev/v1alpha1",
                kind: "BrainBinding",
                metadata: { namespace, name: `${agentName}-default` },
                spec: { agentRef: agentName, sessionRef: sessionName, image: "ghcr.io/hades-dev/hades-brain:dev" },
                status: { phase: "ready", podName: `brain-${agentName}-local` },
            });
        }
        if (!this.state.findByName("Hands", `${agentName}-home-shell`, namespace)) {
            await this.state.apply({
                apiVersion: "hades.dev/v1alpha1",
                kind: "Hands",
                metadata: { namespace, name: `${agentName}-home-shell` },
                spec: { agentRef: agentName, type: "home-toolbox", mode: "exclusive-home", homeRef: agent.spec?.homeRef },
                status: { phase: "ready", podName: `hands-${agentName}-local` },
            });
        }
        agent.status = { ...(agent.status ?? {}), phase: agent.spec?.desiredState ?? "active", session: sessionName };
    }

    resolveAgent(agentRef: string, namespace: string | undefined = undefined): HadesResource {
        if (agentRef.includes("/")) {
            const [refNamespace, refName] = agentRef.split("/", 2);
            const agent = this.state.findByName("Agent", refName, refNamespace);
            if (!agent) throw new Error(`Agent ${refNamespace}/${refName} not found`);
            return agent;
        }
        if (namespace) {
            const agent = this.state.findByName("Agent", agentRef, namespace);
            if (!agent) throw new Error(`Agent ${namespace}/${agentRef} not found`);
            return agent;
        }
        const matches = this.state.list("Agent").filter((agent) => agent.metadata?.name === agentRef);
        if (matches.length === 1) return matches[0];
        if (matches.length > 1) throw new Error(`Agent ${agentRef} is ambiguous; pass namespace or use namespace/name`);
        throw new Error(`Agent ${agentRef} not found`);
    }

    homeRoot(agent: HadesResource): string {
        const homeName = agent.spec?.homeRef ?? `${nameOf(agent)}-home`;
        const home = this.state.findByName("Home", homeName, namespaceOf(agent));
        if (typeof home?.status?.path === "string") return home.status.path;
        return path.join(this.dataDir, "homes", namespaceOf(agent), homeName);
    }
}

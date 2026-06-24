import { CapabilityError, type PolicyDecision } from "../domain/capabilities.js";
import type { AgentSubject, HadesResource } from "../domain/resources.js";
import type { PolicyPort } from "../ports/Policy.js";
import type { StateStorePort } from "../ports/StateStore.js";

export class PolicyService implements PolicyPort {
    constructor(private readonly state: StateStorePort) {}

    grantsFor(subjectKind: string, subjectName: string, namespace: string): HadesResource[] {
        return this.state.list("CapabilityGrant", namespace).filter((grant) => {
            const subject = grant.spec?.subject ?? {};
            return subject.kind === subjectKind && subject.name === subjectName;
        });
    }

    can(subject: AgentSubject, capability: string, resource: { namespace?: string } = {}): PolicyDecision {
        const grants = this.grantsFor(subject.kind, subject.name, subject.namespace);
        for (const grant of grants) {
            if (!(grant.spec?.capabilities ?? []).includes(capability)) continue;
            const constraints = grant.spec?.constraints ?? {};
            if (constraints.namespace === "own" && resource.namespace && resource.namespace !== subject.namespace) continue;
            return { allowed: true, grant: `${grant.metadata?.namespace}/${grant.metadata?.name}` };
        }
        return { allowed: false, reason: `missing capability ${capability}` };
    }

    assert(subject: AgentSubject, capability: string, resource: { namespace?: string } = {}): PolicyDecision {
        const decision = this.can(subject, capability, resource);
        if (!decision.allowed) {
            const reason = "reason" in decision ? decision.reason : "denied";
            throw new CapabilityError(`Capability denied for ${subject.kind}/${subject.name}: ${reason}`, decision);
        }
        return decision;
    }

    resolveAgentSubject(subject: Partial<AgentSubject>): AgentSubject {
        if (subject.kind !== "Agent") throw new Error(`Unsupported subject kind ${subject.kind}`);
        if (!subject.name) throw new Error("Subject name is required");
        if (!subject.namespace) throw new Error("Subject namespace is required");
        const agent = this.state.findByName("Agent", subject.name, subject.namespace);
        if (!agent) throw new Error(`Subject agent ${subject.namespace}/${subject.name} not found`);
        return { kind: "Agent", name: subject.name, namespace: subject.namespace };
    }
}

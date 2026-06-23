import type { StateStore } from "./state.js";
import type { AgentSubject, HadesResource } from "./types.js";

export type PolicyDecision =
    | { allowed: true; grant: string }
    | { allowed: false; reason: string };

export class CapabilityError extends Error {
    decision: PolicyDecision;

    constructor(message: string, decision: PolicyDecision) {
        super(message);
        this.name = "CapabilityError";
        this.decision = decision;
    }
}

export class PolicyEngine {
    state: StateStore;

    constructor(state: StateStore) {
        this.state = state;
    }

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
}

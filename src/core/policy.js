export class PolicyEngine {
    constructor(state) {
        this.state = state;
    }

    grantsFor(subjectKind, subjectName, namespace) {
        return this.state.list("CapabilityGrant", namespace).filter((grant) => {
            const subject = grant.spec?.subject ?? {};
            return subject.kind === subjectKind && subject.name === subjectName;
        });
    }

    can(subject, capability, resource = {}) {
        const grants = this.grantsFor(subject.kind, subject.name, subject.namespace);
        for (const grant of grants) {
            if (!(grant.spec?.capabilities ?? []).includes(capability)) continue;
            const constraints = grant.spec?.constraints ?? {};
            if (constraints.namespace === "own" && resource.namespace && resource.namespace !== subject.namespace) continue;
            return { allowed: true, grant: `${grant.metadata.namespace}/${grant.metadata.name}` };
        }
        return { allowed: false, reason: `missing capability ${capability}` };
    }

    assert(subject, capability, resource = {}) {
        const decision = this.can(subject, capability, resource);
        if (!decision.allowed) {
            const error = new Error(`Capability denied for ${subject.kind}/${subject.name}: ${decision.reason}`);
            error.decision = decision;
            throw error;
        }
        return decision;
    }
}

import { CapabilityError, type PolicyDecision } from "../domain/capabilities.js";
import type { AgentSubject, HadesKind, HadesResource } from "../domain/resources.js";
import type { PolicyPort } from "../ports/Policy.js";
import type { StateStorePort } from "../ports/StateStore.js";

/** Kinds a quota can cap (the create-able resources). */
const QUOTABLE_KINDS: ReadonlySet<HadesKind> = new Set(["Agent", "Home", "Hands", "Listener", "Schedule", "CapabilityGrant"]);

export class PolicyService implements PolicyPort {
    constructor(private readonly state: StateStorePort) {}

    /**
     * Assert a namespace is within its quota for a kind. A `NamespaceQuota`
     * resource in the namespace caps how many of each kind may exist. Absent
     * quota = unlimited (the default for personal use). Throws CapabilityError
     * (a quota denial) when the cap is reached.
     */
    assertQuota(namespace: string, kind: HadesKind): void {
        if (!QUOTABLE_KINDS.has(kind)) return;
        const quota = this.state.findByName("NamespaceQuota", "default", namespace);
        const caps = quota?.spec?.limits as Record<string, number> | undefined;
        const cap = caps?.[kind];
        if (cap === undefined) return; // no cap for this kind
        const count = this.state.list(kind, namespace).length;
        if (count >= cap) {
            throw new CapabilityError(
                `Quota exceeded: ${kind} in ${namespace} (${count}/${cap})`,
                { allowed: false, reason: `quota ${kind} ${count}/${cap} in ${namespace}` },
            );
        }
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

    resolveAgentSubject(subject: Partial<AgentSubject>): AgentSubject {
        if (subject.kind !== "Agent") throw new Error(`Unsupported subject kind ${subject.kind}`);
        if (!subject.name) throw new Error("Subject name is required");
        if (!subject.namespace) throw new Error("Subject namespace is required");
        const agent = this.state.findByName("Agent", subject.name, subject.namespace);
        if (!agent) throw new Error(`Subject agent ${subject.namespace}/${subject.name} not found`);
        return { kind: "Agent", name: subject.name, namespace: subject.namespace };
    }
}

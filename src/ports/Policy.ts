import type { PolicyDecision } from "../domain/capabilities.js";
import type { AgentSubject } from "../domain/resources.js";

export interface PolicyPort {
    can(subject: AgentSubject, capability: string, resource?: { namespace?: string }): PolicyDecision;
    assert(subject: AgentSubject, capability: string, resource?: { namespace?: string }): PolicyDecision;
}

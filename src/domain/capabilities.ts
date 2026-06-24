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

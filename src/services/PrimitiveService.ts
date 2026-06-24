import { isPrimitiveDecision, PRIMITIVES, type AgentOSPrimitive, type PrimitiveDecision } from "../domain/primitives.js";

export class PrimitiveService {
    list(decision?: PrimitiveDecision): AgentOSPrimitive[] {
        if (decision && !isPrimitiveDecision(decision)) throw new Error(`Unknown primitive decision ${decision}`);
        const primitives = decision ? PRIMITIVES.filter((primitive) => primitive.decision === decision) : PRIMITIVES;
        return [...primitives].sort((a, b) => a.layer.localeCompare(b.layer) || a.id.localeCompare(b.id));
    }

}

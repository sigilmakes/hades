import { KINDS, type HadesKind, type HadesResource } from "./resources.js";

/**
 * A structured validation error for a Hades resource. Carries the offending
 * field path so `hades apply` can point at the exact line a manifest is wrong,
 * not just a stack trace.
 */
export class ValidationError extends Error {
    constructor(
        message: string,
        readonly field: string,
        readonly resource: string,
    ) {
        super(`${resource}: ${field}: ${message}`);
        this.name = "ValidationError";
    }
}

const KNOWN_KINDS = new Set<string>(KINDS);

/**
 * Validate a resource's invariants up front. Throws {@link ValidationError}
 * on the first problem. Called by `hades apply` before any resource is
 * persisted, so a malformed manifest fails fast with a clear, field-specific
 * message instead of a late stack trace mid-reconcile.
 *
 * Intentionally minimal — checks shape, not business rules (those live in the
 * services, which throw domain errors). Adding a kind-specific spec contract
 * here keeps `apply` from ever storing something the kernel can't reason about.
 */
export function validateResource(resource: HadesResource): void {
    const name = resource.metadata?.name;
    const id = name ? `${resource.kind ?? "?"}/${name}` : resource.kind ?? "<unknown>";

    if (!resource.kind) throw new ValidationError("missing kind", "kind", id);
    if (!KNOWN_KINDS.has(resource.kind)) {
        throw new ValidationError(`unknown kind '${resource.kind}'. Known: ${KINDS.join(", ")}`, "kind", id);
    }
    if (!resource.metadata) throw new ValidationError("missing metadata", "metadata", id);
    if (!resource.metadata.name) throw new ValidationError("missing name", "metadata.name", id);
    if (typeof resource.metadata.name !== "string" || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(resource.metadata.name)) {
        throw new ValidationError(
            `name '${resource.metadata.name}' must be a lowercase DNS label (a-z, 0-9, '-')`,
            "metadata.name",
            id,
        );
    }
    if (resource.metadata.namespace !== undefined) {
        if (typeof resource.metadata.namespace !== "string" || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(resource.metadata.namespace)) {
            throw new ValidationError(
                `namespace '${resource.metadata.namespace}' must be a lowercase DNS label`,
                "metadata.namespace",
                id,
            );
        }
    }

    // Kind-specific spec contracts — the minimal invariants the kernel relies on.
    const spec = resource.spec ?? {};
    switch (resource.kind as HadesKind) {
        case "Agent":
            if (spec.brain && typeof spec.brain !== "object") throw new ValidationError("brain must be an object", "spec.brain", id);
            if (spec.desiredState && !["active", "idle", "stopped"].includes(spec.desiredState)) {
                throw new ValidationError(`desiredState '${spec.desiredState}' must be active|idle|stopped`, "spec.desiredState", id);
            }
            break;
        case "Schedule":
            if (!spec.type) throw new ValidationError("missing schedule type", "spec.type", id);
            if (!["cron", "interval", "once"].includes(spec.type)) {
                throw new ValidationError(`type '${spec.type}' must be cron|interval|once`, "spec.type", id);
            }
            if (!spec.schedule) throw new ValidationError("missing schedule expression", "spec.schedule", id);
            break;
        case "CapabilityGrant":
            if (!spec.subject) throw new ValidationError("missing subject", "spec.subject", id);
            if (!Array.isArray(spec.capabilities) || spec.capabilities.length === 0) {
                throw new ValidationError("capabilities must be a non-empty array", "spec.capabilities", id);
            }
            break;
        case "Listener":
            if (!spec.platform) throw new ValidationError("missing platform", "spec.platform", id);
            break;
    }
}

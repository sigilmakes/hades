/**
 * The skill catalog — the kernel's discovery table of known installable skills.
 *
 * A Skill is an HTTP capability an agent *exposes*. The catalog is the kernel
 * analogue of a device-driver table or `/sys`: a registry of known-good
 * capabilities with the userland image that implements each, so `hades install
 * skill <name>` resolves a catalog entry into the live resources (a Skill CRD
 * + a CapabilityGrant) the same way `hades new <template>` resolves a template.
 *
 * The catalog is **discovery data only** — the kernel never interprets a skill
 * body. The bodies live in the userland images the catalog points at, exactly
 * as a Linux module table points at `.ko` files without containing the driver
 * code. Listing/instancing a skill is governance + discovery, which are kernel
 * jobs.
 *
 * The catalog is in-tree (compile-time data) so it's versioned with the kernel
 * and auditable. A remote registry is a future userland concern; the kernel's
 * contract is the local table + the install syscall.
 */

/** A catalog entry: a known installable skill + the image that implements it. */
export interface SkillCatalogEntry {
    /** The skill name (DNS-label; becomes the Skill CRD name on install). */
    name: string;
    /** One-line description of what the capability does. */
    description: string;
    /** The userland image that implements this skill (a brain-side handler). */
    image: string;
    /** The port the agent's brain pod serves the capability on. */
    port: number;
    /** A sub-path the capability is rooted at (optional). */
    path?: string;
    /** Longer-form notes shown by `hades skills list`. */
    notes?: string;
}

/**
 * The in-tree catalog of known installable skills. Add an entry here when a
 * new canonical capability image ships. Each points at a userland image the
 * kernel routes to — the kernel never contains the handler logic.
 *
 * The default connector shim (examples/connector-shim) is surfaced as a
 * "webhook" skill so a freshly-installed cluster has one installable example
 * out of the box, mirroring the ClawHub/OpenClaw pattern over plain HTTP.
 */
export const SKILL_CATALOG: readonly SkillCatalogEntry[] = [
    {
        name: "webhook",
        description: "Receive inbound webhooks and forward them to the agent as messages.",
        image: "hades-connector:latest",
        port: 8080,
        path: "/webhook",
        notes: "The default connector shim (examples/connector-shim). Exposes a /webhook endpoint the agent's brain handles; pair with a Connector on the calling side.",
    },
    {
        name: "http-fetch",
        description: "A minimal outbound HTTP fetcher skill an agent exposes for other agents to call.",
        image: "hades-connector:latest",
        port: 8080,
        path: "/fetch",
        notes: "Demonstrates the consume↔expose symmetry: one agent exposes /fetch, others call it via a Connector.",
    },
];

/** The skill catalog kernel service: lookup + list over the in-tree table. */
export class SkillRegistry {
    /** All known catalog entries. */
    list(): SkillCatalogEntry[] {
        return [...SKILL_CATALOG];
    }

    /** Find a catalog entry by name, or undefined if not cataloged. */
    find(name: string): SkillCatalogEntry | undefined {
        return SKILL_CATALOG.find((entry) => entry.name === name);
    }

    /** True if `name` is a known catalog skill. */
    has(name: string): boolean {
        return SKILL_CATALOG.some((entry) => entry.name === name);
    }
}

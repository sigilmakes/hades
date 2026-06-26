import type { AgentSubject } from "../../domain/resources.js";
import type { PolicyPort } from "../../ports/Policy.js";

type PiToolApi = {
    registerTool(tool: unknown): void;
};
type ToolFactory = (definition: unknown) => unknown;
type TypeApi = {
    Object(schema: Record<string, unknown>): unknown;
    String(): unknown;
    Optional(value: unknown): unknown;
};

/** Resolves a connector's credentials from a k8s Secret (by secretRef). */
export interface SecretResolver {
    get(namespace: string, name: string): Promise<Record<string, string> | undefined>;
}

/** A connector the kernel injected into the brain via HADES_CONNECTORS. */
export interface InjectedConnector {
    name: string;
    endpoint: string;
    secretRef?: string;
    egress: string;
}

/** Read the kernel-injected connector manifest from HADES_CONNECTORS env. */
export function connectorsFromEnv(env: NodeJS.ProcessEnv = process.env): InjectedConnector[] {
    const raw = env.HADES_CONNECTORS;
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * A *userland* brain-side adapter (shipped in the brain image, swappable)
 * that turns the kernel-injected `HADES_CONNECTORS` manifest into callable
 * tools. The kernel only routes + governs (NetworkPolicy + env injection);
 * this adapter does the actual HTTP call.
 *
 * Registers one tool per connector: `hades_call_<name>` — POST JSON to the
 * connector endpoint, injecting auth headers from its Secret. Every call is
 * policy-checked against the agent's `networkEgress:*` grant so a revoked
 * grant denies before any bytes leave the pod.
 */
export class ConnectorToolRegistrar {
    constructor(
        private readonly subject: AgentSubject,
        private readonly policy: PolicyPort,
        private readonly secrets: SecretResolver,
        private readonly defineTool: ToolFactory,
        private readonly Type: TypeApi,
        private readonly connectors: InjectedConnector[],
        private readonly fetchImpl: typeof fetch = fetch,
    ) {}

    /** Tool names registered — surfaced so the driver can enable them. */
    get toolNames(): string[] {
        return this.connectors.map((c) => `hades_call_${c.name}`);
    }

    register(api: PiToolApi): void {
        for (const connector of this.connectors) this.registerConnector(api, connector);
    }

    /** One tool per injected connector: POST JSON to its endpoint over HTTP. */
    private registerConnector(api: PiToolApi, connector: InjectedConnector): void {
        const toolName = `hades_call_${connector.name}`;
        api.registerTool(this.defineTool({
            name: toolName,
            label: `Hades Connector: ${connector.name}`,
            description: `Call the ${connector.name} connector at ${connector.endpoint}. Returns the HTTP response body.`,
            parameters: this.Type.Object({
                path: this.Type.Optional(this.Type.String()),
                method: this.Type.Optional(this.Type.String()),
                body: this.Type.Optional(this.Type.String()),
            }),
            execute: async (_id: string, params: { path?: string; method?: string; body?: string }) => {
                // Governance: the kernel only granted egress if the capability
                // is present. Double-check here for a clear error + audit trail
                // (the NetworkPolicy would also drop it).
                if (connector.egress !== "none") {
                    this.policy.assert(this.subject, `networkEgress:${connector.egress}`, { namespace: this.subject.namespace });
                }
                const url = joinPath(connector.endpoint, params.path);
                const headers: Record<string, string> = { "content-type": "application/json" };
                if (connector.secretRef) {
                    const creds = await this.secrets.get(this.subject.namespace, connector.secretRef);
                    if (!creds) throw new Error(`connector ${connector.name}: secret ${connector.secretRef} not found`);
                    Object.assign(headers, creds);
                }
                const res = await this.fetchImpl(url, {
                    method: params.method ?? "GET",
                    headers,
                    ...(params.body ? { body: params.body } : {}),
                });
                const text = await res.text();
                return {
                    content: [{ type: "text", text: `${res.status} ${res.statusText}\n${text.slice(0, 8192)}` }],
                    details: { connector: connector.name, status: res.status, bytes: text.length },
                };
            },
        }));
    }
}

/** Join an endpoint base URL with a path segment (tolerant of slashes). */
function joinPath(endpoint: string, path?: string): string {
    if (!path) return endpoint;
    const sep = endpoint.endsWith("/") || path.startsWith("/") ? "" : "/";
    return `${endpoint}${sep}${path}`;
}

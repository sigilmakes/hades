// Types mirroring the Hades API resource shapes. Kept loose (the API returns
// the full HadesResource JSON); these capture the fields the UI reads.

export type Phase = "pending" | "ready" | "active" | "idle" | "stopped" | "connected" | "waitingForSecret" | "completed" | string;

export interface Metadata {
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  uid?: string;
}

export interface HadesResource {
  apiVersion?: string;
  kind: string;
  metadata: Metadata;
  spec?: Record<string, unknown>;
  status?: { phase?: Phase; [k: string]: unknown };
}

export interface Agent extends HadesResource {
  kind: "Agent";
  spec?: {
    homeRef?: string;
    defaultSession?: string;
    desiredState?: "active" | "idle" | "stopped";
    lifecycle?: "resident" | "ephemeral";
    brain?: { mode?: string; image?: string };
  };
}

export interface ActivityEvent {
  seq: number;
  sessionId: string;
  type: string;
  createdAt: string;
  payload?: Record<string, unknown>;
}

export interface AgentNode {
  agent: Agent;
  listeners?: HadesResource[];
  schedules?: HadesResource[];
}

export interface Approval {
  name: string;
  namespace: string;
  action: string;
  requestedBy: string;
  status: string;
}

export const API_BASE = import.meta.env.VITE_HADES_API ?? "";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${path}`);
  return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} — ${text || path}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  agents: () => getJson<Agent[]>("/hades/v1/agents"),
  agentTree: (ns?: string) => getJson<AgentNode[]>(`/hades/v1/projections/agents${ns ? `?namespace=${ns}` : ""}`),
  activity: (session?: string, limit = 50) =>
    getJson<ActivityEvent[]>(`/hades/v1/projections/activity?limit=${limit}${session ? `&session=${session}` : ""}`),
  approvals: (ns?: string) => getJson<Approval[]>(`/hades/v1/projections/approvals${ns ? `?namespace=${ns}` : ""}`),
  schedules: (ns?: string) => getJson<HadesResource[]>(`/hades/v1/projections/schedules${ns ? `?namespace=${ns}` : ""}`),
  listeners: (ns?: string) => getJson<HadesResource[]>(`/hades/v1/projections/listeners${ns ? `?namespace=${ns}` : ""}`),
  snapshot: (ns?: string) => getJson<Record<string, HadesResource[]>>(`/hades/v1/projections/snapshot${ns ? `?namespace=${ns}` : ""}`),
  healthz: () => getJson<{ ok: boolean }>("/healthz"),
  // Lifecycle actions
  apply: (resource: HadesResource) => postJson<HadesResource>("/hades/v1/resources", resource),
  remove: (kind: string, name: string, namespace = "default") =>
    fetch(`${API_BASE}/hades/v1/resources/${kind}/${name}?namespace=${namespace}`, { method: "DELETE" }).then(async (res) => {
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()) || res.statusText}`);
      return res.json() as Promise<{ ok: boolean; removed: string }>;
    }),
  logs: (name: string, namespace?: string, tail?: number) =>
    getJson<{ text: string }>(`/hades/v1/agents/${name}/logs?${namespace ? `namespace=${namespace}&` : ""}${tail ? `tail=${tail}` : ""}`),
  message: (name: string, text: string, namespace?: string) =>
    postJson<{ run: HadesResource; reply: string }>(`/hades/v1/agents/${name}/message`, { text, namespace }),
  reconcile: () => postJson<{ ok: boolean }>("/hades/v1/reconcile", {}),
};

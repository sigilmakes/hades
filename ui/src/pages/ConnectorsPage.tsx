import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type HadesResource } from "../api.js";
import { Table, type Column } from "../components/Table.js";
import { PhaseBadge } from "../components/PhaseBadge.js";

const API_BASE = import.meta.env.VITE_HADES_API ?? "";

export function ConnectorsPage() {
  const queryClient = useQueryClient();
  const { data: connectors = [], isLoading } = useQuery({ queryKey: ["connectors"], queryFn: () => api.connectors() });

  const deleteMutation = useMutation({
    mutationFn: (c: HadesResource) =>
      fetch(`${API_BASE}/hades/v1/resources/Connector/${c.metadata.name}?namespace=${c.metadata.namespace ?? "default"}`, { method: "DELETE" }).then(async (res) => { if (!res.ok) throw new Error(await res.text()); }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connectors"] }),
  });

  const columns: Column<HadesResource>[] = [
    { header: "Name", render: (c) => <span className="font-mono text-slate-100">{c.metadata.name}</span> },
    { header: "Namespace", render: (c) => <span className="text-slate-400">{c.metadata.namespace ?? "default"}</span> },
    { header: "Agent", render: (c) => <span className="text-slate-400">{String(c.spec?.agentRef ?? "—")}</span> },
    { header: "Endpoint", render: (c) => <span className="font-mono text-xs text-slate-300 break-all">{String(c.spec?.endpoint ?? "—")}</span> },
    { header: "Egress", render: (c) => <span className="text-slate-400">{String(c.spec?.egress ?? "none")}</span> },
    { header: "Phase", render: (c) => <PhaseBadge phase={c.status?.phase} /> },
    { header: "", render: (c) => (
      <button
        onClick={() => deleteMutation.mutate(c)}
        className="text-xs text-slate-500 hover:text-red-400"
      >✕</button>
    ) },
  ];

  return (
    <div className="p-6">
      <header className="mb-5">
        <h1 className="text-xl font-semibold text-slate-100">Connectors</h1>
        <p className="text-sm text-slate-500">HTTP capability endpoints the kernel routes + governs for agents</p>
      </header>
      {isLoading ? <div className="text-sm text-slate-500">Loading…</div> : <Table columns={columns} rows={connectors} empty="No connectors. Attach one via hades_apply or the attach-connector syscall." />}
    </div>
  );
}

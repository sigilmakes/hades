import { useQuery } from "@tanstack/react-query";
import { api, type HadesResource } from "../api.js";
import { Table, type Column } from "../components/Table.js";
import { PhaseBadge } from "../components/PhaseBadge.js";

export function ListenersPage() {
  const { data: listeners = [], isLoading } = useQuery({ queryKey: ["listeners"], queryFn: () => api.listeners() });

  const columns: Column<HadesResource>[] = [
    { header: "Name", render: (l) => <span className="font-mono text-slate-100">{l.metadata.name}</span> },
    { header: "Namespace", render: (l) => <span className="text-slate-400">{l.metadata.namespace ?? "default"}</span> },
    { header: "Platform", render: (l) => <span className="text-slate-400">{String(l.spec?.platform ?? "—")}</span> },
    { header: "Agent", render: (l) => <span className="text-slate-400">{String(l.spec?.agentRef ?? "—")}</span> },
    { header: "Phase", render: (l) => <PhaseBadge phase={l.status?.phase} /> },
    { header: "Secret", render: (l) => <span className="text-slate-400">{String(l.spec?.secretRef ?? "—")}</span> },
  ];

  return (
    <div className="p-6">
      <header className="mb-5">
        <h1 className="text-xl font-semibold text-slate-100">Listeners</h1>
        <p className="text-sm text-slate-500">Inbound message bridges (Discord, Matrix, CLI…)</p>
      </header>
      {isLoading ? <div className="text-sm text-slate-500">Loading…</div> : <Table columns={columns} rows={listeners} empty="No listeners attached." />}
    </div>
  );
}

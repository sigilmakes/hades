import { useQuery } from "@tanstack/react-query";
import { api, type HadesResource } from "../api.js";
import { Table, type Column } from "../components/Table.js";
import { PhaseBadge } from "../components/PhaseBadge.js";

export function SchedulesPage() {
  const { data: schedules = [], isLoading } = useQuery({ queryKey: ["schedules"], queryFn: () => api.schedules() });

  const columns: Column<HadesResource>[] = [
    { header: "Name", render: (s) => <span className="font-mono text-slate-100">{s.metadata.name}</span> },
    { header: "Namespace", render: (s) => <span className="text-slate-400">{s.metadata.namespace ?? "default"}</span> },
    { header: "Type", render: (s) => <span className="text-slate-400">{String(s.spec?.type ?? "—")}</span> },
    { header: "Schedule", render: (s) => <span className="font-mono text-slate-300">{String(s.spec?.schedule ?? "—")}</span> },
    { header: "Agent", render: (s) => <span className="text-slate-400">{String(s.spec?.agentRef ?? "—")}</span> },
    { header: "Phase", render: (s) => <PhaseBadge phase={s.status?.phase} /> },
  ];

  return (
    <div className="p-6">
      <header className="mb-5">
        <h1 className="text-xl font-semibold text-slate-100">Schedules</h1>
        <p className="text-sm text-slate-500">Cron, interval, and one-shot prompts</p>
      </header>
      {isLoading ? <div className="text-sm text-slate-500">Loading…</div> : <Table columns={columns} rows={schedules} empty="No schedules." />}
    </div>
  );
}

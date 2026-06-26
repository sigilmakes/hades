import { useQuery } from "@tanstack/react-query";
import { api, type Approval } from "../api.js";
import { Table, type Column } from "../components/Table.js";
import { PhaseBadge } from "../components/PhaseBadge.js";

export function ApprovalsPage() {
  const { data: approvals = [], isLoading } = useQuery({ queryKey: ["approvals"], queryFn: () => api.approvals() });

  const columns: Column<Approval>[] = [
    { header: "Name", render: (a) => <span className="font-mono text-slate-100">{a.name}</span> },
    { header: "Namespace", render: (a) => <span className="text-slate-400">{a.namespace}</span> },
    { header: "Action", render: (a) => <span className="font-mono text-slate-300">{a.action}</span> },
    { header: "Requested by", render: (a) => <span className="text-slate-400">{a.requestedBy}</span> },
    { header: "Status", render: (a) => <PhaseBadge phase={a.status} /> },
  ];

  return (
    <div className="p-6">
      <header className="mb-5">
        <h1 className="text-xl font-semibold text-slate-100">Approvals</h1>
        <p className="text-sm text-slate-500">Capability-gated actions awaiting a human decision</p>
      </header>
      {isLoading ? <div className="text-sm text-slate-500">Loading…</div> : <Table columns={columns} rows={approvals} empty="No pending approvals. 🎉" />}
    </div>
  );
}

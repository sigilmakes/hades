import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Approval } from "../api.js";
import { Table, type Column } from "../components/Table.js";
import { PhaseBadge } from "../components/PhaseBadge.js";

const API_BASE = import.meta.env.VITE_HADES_API ?? "";

export function ApprovalsPage() {
  const queryClient = useQueryClient();
  const { data: approvals = [], isLoading } = useQuery({ queryKey: ["approvals"], queryFn: () => api.approvals() });
  const [notes, setNotes] = useState<Record<string, string>>({});

  const respondMutation = useMutation({
    mutationFn: ({ approval, decision }: { approval: Approval; decision: "approve" | "deny" }) =>
      fetch(
        `${API_BASE}/hades/v1/approvals/${approval.name}/respond?decision=${decision}&namespace=${approval.namespace}`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note: notes[approval.name] }) },
      ).then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${(await res.text()) || res.statusText}`);
        return res.json();
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["approvals"] }),
  });

  const columns: Column<Approval>[] = [
    { header: "Name", render: (a) => <span className="font-mono text-slate-100">{a.name}</span> },
    { header: "Namespace", render: (a) => <span className="text-slate-400">{a.namespace}</span> },
    { header: "Action", render: (a) => <span className="font-mono text-slate-300">{a.action}</span> },
    { header: "Requested by", render: (a) => <span className="text-slate-400">{a.requestedBy}</span> },
    { header: "Status", render: (a) => <PhaseBadge phase={a.status} /> },
    {
      header: "Decision",
      render: (a) => (
        <div className="flex items-center gap-2">
          <input
            value={notes[a.name] ?? ""}
            onChange={(e) => setNotes((n) => ({ ...n, [a.name]: e.target.value }))}
            placeholder="note (optional)"
            className="w-32 rounded border border-hades-border bg-slate-950 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-600 focus:border-hades-accent focus:outline-none"
          />
          <button
            onClick={() => respondMutation.mutate({ approval: a, decision: "approve" })}
            disabled={respondMutation.isPending}
            className="rounded border border-emerald-500/40 px-2 py-1 text-xs font-medium text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-40"
          >approve</button>
          <button
            onClick={() => respondMutation.mutate({ approval: a, decision: "deny" })}
            disabled={respondMutation.isPending}
            className="rounded border border-red-500/40 px-2 py-1 text-xs font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-40"
          >deny</button>
        </div>
      ),
    },
  ];

  return (
    <div className="p-6">
      <header className="mb-5">
        <h1 className="text-xl font-semibold text-slate-100">Approvals</h1>
        <p className="text-sm text-slate-500">Capability-gated actions awaiting a human decision</p>
      </header>
      {respondMutation.isError && (
        <div className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {(respondMutation.error as Error).message}
        </div>
      )}
      {isLoading ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : (
        <Table columns={columns} rows={approvals} empty="No pending approvals. 🎉" />
      )}
    </div>
  );
}

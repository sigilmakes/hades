import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Agent } from "../api.js";
import { Table, type Column } from "../components/Table.js";
import { PhaseBadge } from "../components/PhaseBadge.js";
import { Drawer, Field } from "../components/Drawer.js";

export function AgentsPage() {
  const [selected, setSelected] = useState<Agent | null>(null);
  const [message, setMessage] = useState("");
  const queryClient = useQueryClient();
  const { data: agents = [], isLoading } = useQuery({ queryKey: ["agents"], queryFn: api.agents });

  const columns: Column<Agent>[] = [
    {
      header: "Name",
      render: (a) => (
        <span className="font-mono font-medium text-slate-100">{a.metadata.name}</span>
      ),
    },
    { header: "Namespace", render: (a) => <span className="text-slate-400">{a.metadata.namespace ?? "default"}</span> },
    { header: "Phase", render: (a) => <PhaseBadge phase={a.status?.phase} /> },
    { header: "State", render: (a) => <span className="text-slate-400">{a.spec?.desiredState ?? "—"}</span> },
    { header: "Lifecycle", render: (a) => <span className="text-slate-400">{a.spec?.lifecycle ?? "resident"}</span> },
    { header: "Brain", render: (a) => <span className="text-slate-400">{(a.spec?.brain as { mode?: string })?.mode ?? "—"}</span> },
  ];

  const sendMutation = useMutation({
    mutationFn: ({ name, namespace }: { name: string; namespace?: string }) =>
      api.message(name, message, namespace),
    onSuccess: () => {
      setMessage("");
      queryClient.invalidateQueries({ queryKey: ["activity"] });
    },
  });

  return (
    <div className="p-6">
      <header className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Agents</h1>
          <p className="text-sm text-slate-500">{agents.length} resident + ephemeral workloads</p>
        </div>
      </header>
      {isLoading ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : (
        <Table columns={columns} rows={agents} onRowClick={setSelected} empty="No agents. Create one with + New Agent." />
      )}

      <Drawer open={!!selected} onClose={() => setSelected(null)} title={selected ? `Agent · ${selected.metadata.name}` : ""}>
        {selected && (
          <div className="space-y-4">
            <dl>
              <Field label="namespace">{selected.metadata.namespace ?? "default"}</Field>
              <Field label="phase"><PhaseBadge phase={selected.status?.phase} /></Field>
              <Field label="desired state">{selected.spec?.desiredState ?? "—"}</Field>
              <Field label="lifecycle">{selected.spec?.lifecycle ?? "resident"}</Field>
              <Field label="home">{selected.spec?.homeRef ?? "—"}</Field>
              <Field label="session">{selected.spec?.defaultSession ?? "—"}</Field>
              <Field label="brain mode">{(selected.spec?.brain as { mode?: string })?.mode ?? "—"}</Field>
              <Field label="uid">{selected.metadata.uid ?? "—"}</Field>
            </dl>

            <div className="pt-2">
              <label className="mb-1 block text-xs uppercase tracking-wide text-slate-500">Send a message</label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
                placeholder={`Prompt ${selected.metadata.name}…`}
                className="w-full resize-none rounded-md border border-hades-border bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-hades-accent focus:outline-none"
              />
              <div className="mt-2 flex items-center gap-3">
                <button
                  onClick={() => sendMutation.mutate({ name: selected.metadata.name, namespace: selected.metadata.namespace })}
                  disabled={!message.trim() || sendMutation.isPending}
                  className="rounded-md bg-hades-accent px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-orange-600 disabled:opacity-40"
                >
                  {sendMutation.isPending ? "Sending…" : "Send"}
                </button>
                {sendMutation.isError && (
                  <span className="text-xs text-red-400">{(sendMutation.error as Error).message}</span>
                )}
                {sendMutation.isSuccess && (
                  <span className="truncate text-xs text-emerald-400">↳ {sendMutation.data.reply}</span>
                )}
              </div>
            </div>

            <details className="pt-2">
              <summary className="cursor-pointer text-xs uppercase tracking-wide text-slate-500">raw spec</summary>
              <pre className="mt-2 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-300">
                {JSON.stringify(selected.spec ?? {}, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </Drawer>
    </div>
  );
}

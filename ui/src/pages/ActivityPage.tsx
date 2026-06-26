import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";

// Color-code event types so the activity stream reads at a glance.
function typeColor(type: string): string {
  if (type.endsWith(".applied") || type.endsWith(".reconciled")) return "text-emerald-400";
  if (type.endsWith(".removed") || type.endsWith(".finalized") || type.endsWith(".cascaded")) return "text-red-400";
  if (type.endsWith(".waiting")) return "text-amber-400";
  if (type.startsWith("brain.") || type.startsWith("hands.")) return "text-sky-400";
  return "text-slate-400";
}

export function ActivityPage() {
  const { data: events = [], isLoading } = useQuery({
    queryKey: ["activity"],
    queryFn: () => api.activity(undefined, 100),
  });

  return (
    <div className="p-6">
      <header className="mb-5">
        <h1 className="text-xl font-semibold text-slate-100">Activity</h1>
        <p className="text-sm text-slate-500">Live durable event stream (last 100)</p>
      </header>
      {isLoading ? (
        <div className="text-sm text-slate-500">Loading…</div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-hades-border bg-hades-panel">
          <div className="max-h-[calc(100vh-180px)] overflow-auto">
            {events.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-slate-500">No events yet.</div>
            ) : (
              <ul className="divide-y divide-hades-border font-mono text-xs">
                {events.map((e) => (
                  <li key={e.seq} className="flex gap-3 px-4 py-2 hover:bg-slate-800/30">
                    <span className="shrink-0 text-slate-600">{String(e.seq).padStart(5, "0")}</span>
                    <span className="shrink-0 text-slate-500">{new Date(e.createdAt).toLocaleTimeString()}</span>
                    <span className={`shrink-0 ${typeColor(e.type)}`}>{e.type}</span>
                    <span className="truncate text-slate-400">
                      {e.payload ? Object.entries(e.payload).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ") : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

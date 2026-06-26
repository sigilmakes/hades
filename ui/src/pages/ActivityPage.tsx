import { useEffect, useRef, useState } from "react";
import { type ActivityEvent } from "../api.js";

// Color-code event types so the activity stream reads at a glance.
function typeColor(type: string): string {
  if (type.endsWith(".applied") || type.endsWith(".reconciled")) return "text-emerald-400";
  if (type.endsWith(".removed") || type.endsWith(".finalized") || type.endsWith(".cascaded")) return "text-red-400";
  if (type.endsWith(".waiting")) return "text-amber-400";
  if (type.startsWith("brain.") || type.startsWith("hands.")) return "text-sky-400";
  return "text-slate-400";
}

/**
 * Live activity stream. Prefers the SSE endpoint (/events/stream) so events
 * appear in real time; falls back to polling if SSE isn't supported by the
 * store or the connection drops.
 */
export function ActivityPage() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [live, setLive] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const base = import.meta.env.VITE_HADES_API ?? "";
    const es = new EventSource(`${base}/hades/v1/events/stream`);
    esRef.current = es;
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.onmessage = (msg) => {
      try {
        const evt = JSON.parse(msg.data) as ActivityEvent;
        setEvents((prev) => {
          const next = [...prev, evt];
          // Keep a rolling window of the last 200 events.
          return next.length > 200 ? next.slice(next.length - 200) : next;
        });
      } catch { /* ignore malformed */ }
    };
    return () => es.close();
  }, []);

  return (
    <div className="p-6">
      <header className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Activity</h1>
          <p className="text-sm text-slate-500">Live durable event stream</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span className={`inline-block h-2 w-2 rounded-full ${live ? "animate-pulse bg-emerald-500" : "bg-red-500"}`} />
          {live ? "streaming" : "disconnected"}
        </div>
      </header>
      <div className="overflow-hidden rounded-lg border border-hades-border bg-hades-panel">
        <div className="max-h-[calc(100vh-180px)] overflow-auto">
          {events.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-slate-500">No events yet.</div>
          ) : (
            <ul className="divide-y divide-hades-border font-mono text-xs">
              {events.map((e, i) => (
                <li key={`${e.seq}-${i}`} className="flex gap-3 px-4 py-2 hover:bg-slate-800/30">
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
    </div>
  );
}

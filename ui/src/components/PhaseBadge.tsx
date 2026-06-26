import type { Phase } from "../api.js";

// Map a resource phase to a tailwind color token. The phases come from the
// controller's status writes; unknown phases fall back to slate.
const PHASE_STYLES: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30",
  ready: "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30",
  connected: "bg-emerald-500/15 text-emerald-400 ring-emerald-500/30",
  pending: "bg-amber-500/15 text-amber-400 ring-amber-500/30",
  waitingForSecret: "bg-amber-500/15 text-amber-400 ring-amber-500/30",
  idle: "bg-slate-500/15 text-slate-300 ring-slate-500/30",
  stopped: "bg-slate-500/15 text-slate-300 ring-slate-500/30",
  completed: "bg-sky-500/15 text-sky-400 ring-sky-500/30",
  failed: "bg-red-500/15 text-red-400 ring-red-500/30",
};

export function PhaseBadge({ phase }: { phase?: Phase }) {
  const label = phase ?? "—";
  const style = PHASE_STYLES[label] ?? "bg-slate-500/15 text-slate-400 ring-slate-500/30";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${style}`}
    >
      {label}
    </span>
  );
}

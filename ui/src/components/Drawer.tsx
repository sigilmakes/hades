import type { ReactNode } from "react";

/** A right-side detail drawer (Headlamp-style resource inspector). */
export function Drawer({ open, onClose, title, children }: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex">
      <div className="flex-1 bg-black/50" onClick={onClose} />
      <div className="flex w-full max-w-xl flex-col border-l border-hades-border bg-hades-panel shadow-2xl">
        <div className="flex items-center justify-between border-b border-hades-border px-5 py-4">
          <h2 className="font-mono text-sm font-semibold text-slate-200">{title}</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-auto p-5">{children}</div>
      </div>
    </div>
  );
}

/** A labelled key/value row for the detail view. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-3 border-b border-hades-border py-2 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="col-span-2 break-all font-mono text-slate-200">{children}</dd>
    </div>
  );
}

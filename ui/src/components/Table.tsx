import type { ReactNode } from "react";

export interface Column<T> {
  header: string;
  render: (row: T) => ReactNode;
  className?: string;
}

/** A minimal, dark-themed data table. Headlamp-style: sortable later, KISS now. */
export function Table<T>({ columns, rows, onRowClick, empty }: {
  columns: Column<T>[];
  rows: T[];
  onRowClick?: (row: T) => void;
  empty?: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-hades-border">
      <table className="w-full text-sm">
        <thead className="bg-slate-900/60 text-xs uppercase tracking-wide text-slate-400">
          <tr>
            {columns.map((c) => (
              <th key={c.header} className={`px-4 py-3 text-left font-medium ${c.className ?? ""}`}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-hades-border">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-10 text-center text-slate-500">
                {empty ?? "No resources."}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr
                key={i}
                onClick={() => onRowClick?.(row)}
                className={`transition-colors ${onRowClick ? "cursor-pointer hover:bg-slate-800/50" : ""}`}
              >
                {columns.map((c, j) => (
                  <td key={j} className={`px-4 py-3 ${c.className ?? ""}`}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

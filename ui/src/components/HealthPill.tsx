import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";

/** A small green/red pill showing API health, polled every 5s. */
export function HealthPill() {
  const { data, isError } = useQuery({
    queryKey: ["healthz"],
    queryFn: api.healthz,
    refetchInterval: 5000,
    retry: 0,
  });
  const ok = data?.ok && !isError;
  return (
    <div className="flex items-center gap-2 text-xs text-slate-400">
      <span
        className={`inline-block h-2 w-2 rounded-full ${ok ? "bg-emerald-500" : "bg-red-500"}`}
      />
      {ok ? "online" : "offline"}
    </div>
  );
}

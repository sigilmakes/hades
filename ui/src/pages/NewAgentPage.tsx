import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type HadesResource } from "../api.js";
import { useNavigate } from "react-router-dom";

const PLATFORMS = [
  { value: "", label: "None (CLI / API only)" },
  { value: "discord", label: "Discord" },
  { value: "matrix", label: "Matrix" },
  { value: "cli", label: "CLI" },
];

// A small, opinionated form that POSTs an Agent (+ optional Listener + Home)
// to the Hades API. This is the "easy spin-up" path: name it, pick a brain,
// optionally attach an external service, submit.
export function NewAgentPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [namespace, setNamespace] = useState("default");
  const [brainMode, setBrainMode] = useState("pi-sdk");
  const [platform, setPlatform] = useState("");
  const [secretRef, setSecretRef] = useState("");

  const createMutation = useMutation({
    mutationFn: async () => {
      // 1. Home (shared, durable) — one per agent.
      const home: HadesResource = {
        kind: "Home",
        metadata: { name: `${name}-home`, namespace },
        spec: {},
      };
      await api.apply(home);
      // 2. The agent itself — resident, active, pointing at the home.
      const agent: HadesResource = {
        kind: "Agent",
        metadata: { name, namespace },
        spec: {
          homeRef: `${name}-home`,
          defaultSession: `${name}-default`,
          desiredState: "active",
          lifecycle: "resident",
          brain: { mode: brainMode },
        },
      };
      await api.apply(agent);
      // 3. Optionally attach a listener bound to an external service.
      if (platform) {
        const listener: HadesResource = {
          kind: "Listener",
          metadata: { name: `${name}-${platform}`, namespace },
          spec: { agentRef: name, platform, ...(secretRef ? { secretRef } : {}) },
        };
        await api.apply(listener);
      }
      // Reconcile so pods materialize immediately.
      await api.reconcile();
    },
    onSuccess: () => {
      queryClient.invalidateQueries();
      navigate("/");
    },
  });

  const valid = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name);

  return (
    <div className="mx-auto max-w-2xl p-6">
      <header className="mb-6">
        <h1 className="text-xl font-semibold text-slate-100">New Agent</h1>
        <p className="text-sm text-slate-500">Spin up a persistent agent and optionally attach it to an external service.</p>
      </header>

      <form
        onSubmit={(e) => { e.preventDefault(); if (valid) createMutation.mutate(); }}
        className="space-y-5"
      >
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-300">Agent name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            placeholder="atlas"
            className="w-full rounded-md border border-hades-border bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-600 focus:border-hades-accent focus:outline-none"
          />
          {name && !valid && <p className="mt-1 text-xs text-red-400">Lowercase, a-z 0-9 and '-' only.</p>}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-300">Namespace</label>
            <input
              value={namespace}
              onChange={(e) => setNamespace(e.target.value.toLowerCase())}
              className="w-full rounded-md border border-hades-border bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 focus:border-hades-accent focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-300">Brain mode</label>
            <select
              value={brainMode}
              onChange={(e) => setBrainMode(e.target.value)}
              className="w-full rounded-md border border-hades-border bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-hades-accent focus:outline-none"
            >
              <option value="pi-sdk">pi-sdk (live model)</option>
              <option value="test">test (offline loop)</option>
            </select>
          </div>
        </div>

        <fieldset className="rounded-lg border border-hades-border p-4">
          <legend className="px-2 text-sm font-medium text-slate-300">Attach an external service</legend>
          <div className="mt-2 space-y-4">
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wide text-slate-500">Platform</label>
              <select
                value={platform}
                onChange={(e) => setPlatform(e.target.value)}
                className="w-full rounded-md border border-hades-border bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-hades-accent focus:outline-none"
              >
                {PLATFORMS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            {platform && (platform === "discord" || platform === "matrix") && (
              <div>
                <label className="mb-1 block text-xs uppercase tracking-wide text-slate-500">Secret ref (k8s Secret with the bot token)</label>
                <input
                  value={secretRef}
                  onChange={(e) => setSecretRef(e.target.value)}
                  placeholder={`${name}-${platform}-token`}
                  className="w-full rounded-md border border-hades-border bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-600 focus:border-hades-accent focus:outline-none"
                />
                <p className="mt-1 text-xs text-slate-500">
                  Create the Secret first: <code className="text-slate-400">kubectl create secret generic {secretRef || `${name}-${platform}-token`} --from-literal=token=…</code>
                </p>
              </div>
            )}
          </div>
        </fieldset>

        {createMutation.isError && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {(createMutation.error as Error).message}
          </div>
        )}

        <div className="flex justify-end gap-3">
          <button type="button" onClick={() => navigate("/")} className="rounded-md px-4 py-2 text-sm text-slate-400 hover:text-white">
            Cancel
          </button>
          <button
            type="submit"
            disabled={!valid || createMutation.isPending}
            className="rounded-md bg-hades-accent px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-orange-600 disabled:opacity-40"
          >
            {createMutation.isPending ? "Creating…" : "Create agent"}
          </button>
        </div>
      </form>
    </div>
  );
}

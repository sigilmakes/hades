# Setup

Hades runs in two modes: a local single-process kernel (dev) and a distributed
Kubernetes operator (deploy). Both share one kernel behind the same ports.

## Requirements

- Node 24 (recommended) or 22.19+
- `npm install`

## Run the offline demo (no model, no network)

The generic example uses the **test brain** — an offline directive interpreter
(`!write`, `!read`, `!exec`, `!schedule`). It proves the kernel loop end-to-end
without any model provider.

```bash
npm test              # 128 tests
./bin/hades demo      # applies examples/generic/alpha.json and runs the loop
```

## Run an agent manifest

```bash
./bin/hades up examples/generic/alpha.json
./bin/hades say agent-demo/demo "!write vault/note.md <<<hello"
./bin/hades say agent-demo/demo "!read vault/note.md"
./bin/hades tail demo-default
./bin/hades state
./bin/hades primitives adopt     # the researched primitive catalog
```

`./bin/hades` builds `dist/` if needed. State lives under `HADES_DATA_DIR`
(default `./.hades`).

## Brain modes

The brain is the model/harness loop. Two modes:

- **`pi-sdk` (default)** — the real brain. Runs a pi SDK session that routes `hades_read`/`hades_write`/`hades_exec` through hands. **Requires a working model provider in your environment.** See "Real model" below.
- **`test`** — offline directive brain for tests/demos. Set with `spec.brain.mode: "test"` on the Agent or `HADES_BRAIN_MODE=test`.

```bash
HADES_BRAIN_MODE=test ./bin/hades say agent-demo/demo "hello"
```

## Real model (not bundled)

Hades does **not** bundle a model provider or assume one works. The pi-SDK
brain uses whatever providers/keys your pi environment is configured with. To
run the real brain you need a working model in your pi setup (an
Anthropic/OpenAI key, or a configured custom provider). If no model resolves,
the brain run fails with a clear error — that is the correct signal, not a bug.

## Local hands confinement

The local runtime has **no real isolation**, so the default sandbox profile
(`confined-local`) refuses:

- absolute paths (even inside Home)
- `..` traversal
- shell metacharacters
- host interpreters (`bash`, `sh`, `python`, `node`, …) as the executable
- executable symlinks
- denied shebang interpreters

This is a **profile choice, not a hardcoded constant**: `SandboxProfile`
carries the policy. `ContainerHands` uses the `permissive-container` profile
to allow bash/python/node under real container isolation. The brain depends on
the profile, not on hardcoded rules. See `src/domain/sandbox.ts`.

## Schedules

Schedules are first-class and kernel-owned. Three types:

- `once` — ISO timestamp (or `+Ns/m/h` relative to creation). Fires once.
- `interval` — `+Ns/m/h`. Recurring.
- `cron` — 5-field Vixie expression via `croner`. Recurring, current-minute match.

```bash
./bin/hades say agent-demo/demo "!schedule check once 1970-01-01T00:00:00Z :: scheduled hello"
./bin/hades reconcile   # fires due schedules
```

A malformed schedule is marked `invalid` and skipped without crashing the
reconcile loop. A transient delivery failure emits `schedule.failed` and leaves
the schedule active to retry. Concurrent reconciles cannot double-fire (the
occurrence is claimed synchronously before the await).

## Where state lives

```text
$HADES_DATA_DIR/
├── state.json            # resource state
├── events/*.jsonl        # durable session/event logs
└── homes/<ns>/<home>/    # agent userland (vault/, bin/, cron.d/, …)
```

In distributed mode, state and events live in SQLite on a PVC; homes are
individual PVCs.

## Spawning throwaway agents

A resident agent with the `spawnAgent` capability can mint an ephemeral worker
for one task:

```bash
./bin/hades say agent-demo/demo "!spawn helper do a small task"
```

The worker is created as an `ephemeral` agent, run once, then reaped
(`phase: completed`). Without the grant, the spawn is denied. Ephemeral workers
get no capabilities by default; the spawner may grant a narrow subset.

## Distributed mode

```bash
# Install CRDs, namespace, RBAC, and the data PVC
kubectl apply -f infra/k8s/crds/hades.dev_resources.yaml
kubectl apply -f infra/k8s/namespace-rbac.yaml

# Run the controller. HADES_KUBE=1 uses the real cluster client.
HADES_MODE=distributed HADES_KUBE=1 ./bin/hades controller
```

See [`infra/README.md`](../infra/README.md) for the controller reconciliation
table and node-count-agnostic storage notes.

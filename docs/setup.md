# Setup

Hades runs as a single-process kernel today. This guide is honest about what works without external services and what depends on your environment.

## Requirements

- Node 24 (recommended) or 22.19+
- `npm install`

## Run the offline demo (no model, no network)

The generic example uses the **test brain** — an offline directive interpreter (`!write`, `!read`, `!exec`, `!schedule`). It proves the kernel loop end-to-end without any model provider.

```bash
npm test              # 31 tests
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

`./bin/hades` builds `dist/` if needed. State lives under `HADES_DATA_DIR` (default `./.hades`).

## Brain modes

The brain is the model/harness loop. Two modes:

- **`pi-sdk` (default)** — the real brain. Runs a pi SDK session that routes `hades_read`/`hades_write`/`hades_exec` through Hands. **Requires a working model provider in your environment.** See "Real model" below.
- **`test`** — offline directive brain for tests/demos. Set with `spec.brain.mode: "test"` on the Agent or `HADES_BRAIN_MODE=test`.

```bash
HADES_BRAIN_MODE=test ./bin/hades say agent-demo/demo "hello"
```

There is intentionally **no alias** for the removed `deterministic` mode or `!bash` directive — they fail loudly. Use `test` + `!exec`.

## Real model (honest, not bundled)

Hades does **not** bundle a model provider or assume one works. The pi-SDK brain uses whatever providers/keys your pi environment is configured with. To run the real brain you need a working model in your pi setup (e.g. an Anthropic/OpenAI key, or a configured custom provider). If no model resolves, the brain run fails with a clear error — that is the correct signal, not a bug.

Hades deliberately does not hardcode a model like `qwen3-coder` into examples. Model selection is per-environment and not yet wired into the runtime as a resource; see `docs/architecture.md` for the brain/hands/session design.

## Local hands confinement

The local prototype has **no real isolation**, so the default sandbox profile (`confined-local`) refuses:

- absolute paths (even inside Home)
- `..` traversal
- shell metacharacters
- host interpreters (`bash`, `sh`, `python`, `node`, …) as the executable
- executable symlinks
- denied shebang interpreters

This is a **profile choice, not a hardcoded constant**: `SandboxProfile` carries the policy, so a future container-backed hands backend can allow bash/python/node under real isolation without touching the brain or parser. The brain depends on the profile, not on hardcoded rules. See `src/domain/sandbox.ts`.

## Schedules

Schedules are first-class and kernel-owned. Three types:

- `once` — ISO timestamp (or `+Ns/m/h` relative to creation). Fires once.
- `interval` — `Ns/m/h`. Recurring.
- `cron` — 5-field Vixie expression via `croner`. Recurring, current-minute match (no catch-up across downtime in v0).

```bash
./bin/hades say agent-demo/demo "!schedule check once 1970-01-01T00:00:00Z :: scheduled hello"
./bin/hades reconcile   # fires due schedules
```

A malformed schedule is marked `invalid` and skipped without crashing the reconcile loop. A transient delivery failure emits `schedule.failed` and leaves the schedule active to retry. Concurrent reconciles cannot double-fire (the occurrence is claimed synchronously before the await).

## Where state lives

```text
$HADES_DATA_DIR/
├── state.json            # resource state
├── events/*.jsonl        # durable session/event logs
└── homes/<ns>/<home>/    # agent userland (vault/, bin/, cron.d/, …)
```

## Spawning throwaway agents

A resident agent with the `spawnAgent` capability can mint an ephemeral worker for one task:

```bash
./bin/hades say agent-demo/demo "!spawn helper do a small task"
```

The worker is created as an `ephemeral` agent, run once, then reaped (`phase: completed`). Without the grant, the spawn is denied. Ephemeral workers get no capabilities by default; the spawner may grant a narrow subset.

## What is not here yet

- Real platform listener bridges (Discord/Matrix/email)
- Kubernetes controllers (the local prototype reconciles in-process)
- A real event/projection store (JSON/JSONL today)
- A wired per-agent model policy

These are adapters behind existing ports — the kernel shape is stable. See `docs/architecture.md`.
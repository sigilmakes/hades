# Hades

Hades is a **Kubernetes-native agent operating system**: a small kernel that
supervises agent workloads — brains, hands, listeners — as disposable pods,
while durable state (sessions, homes, capabilities) survives every crash.

There is one kernel and two kinds of agents, like a Linux box has daemons and
throwaway processes:

- **Resident agents** — long-running, privileged, with durable state.
- **Ephemeral agents** — short-lived, confined, spawned for one task and reaped.

The kernel owns the boring, precious things — scheduling, durable session/event
logs, agent Homes, the capability system — and supervises squishy workloads
that are spun up when there is work and killed when idle. Crash is not a
disaster: the kernel re-wakes a brain from its durable log.

## Quickstart

```bash
npm install
npm test              # 128 tests, offline
./bin/hades demo      # offline loop via the test brain, no model needed
```

Day-to-day from a checkout:

```bash
./bin/hades init
./bin/hades up examples/generic/alpha.json
./bin/hades say agent-demo/demo "!write vault/hello.md <<<hello"
./bin/hades say agent-demo/demo "!read vault/hello.md"
./bin/hades tail demo-default
./bin/hades state
./bin/hades primitives adopt      # researched primitive catalog
./bin/hades serve                 # HTTP API
```

`./bin/hades` builds `dist/` if needed. State lives under `HADES_DATA_DIR`
(default `./.hades`).

## Brains

- **`pi-sdk` (default)** — the real brain. Routes `hades_read`/`hades_write`/`hades_exec` through hands. Needs a working model in your environment — Hades bundles no model and assumes none.
- **`test`** — offline directive brain for tests/demos. `HADES_BRAIN_MODE=test` or `spec.brain.mode: "test"`.

## Distributed mode

```bash
HADES_MODE=distributed HADES_KUBE=1 ./bin/hades controller
```

The same kernel runs with pod-backed adapters behind the same ports. The
controller reconciles Hades custom resources into native Kubernetes objects
(Deployments for brains, PVCs for homes, CronJobs for schedules,
NetworkPolicies for capability projection). See
[`infra/README.md`](infra/README.md).

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — how the system works: the kernel, the resident/ephemeral model, the two runtimes, the privilege ladder.
- [`docs/setup.md`](docs/setup.md) — setup: what works offline, what needs your environment, local hands confinement, schedules, where state lives.
- [`docs/development.md`](docs/development.md) — dev guide: KISS/SOLID, ports-and-adapters, the kernel analogy, code style, testing, adding adapters and syscalls.
- [`spec/`](spec/) — the full spec set, verified against the codebase.

## Code shape

```text
src/domain/      resource, event, capability, sandbox, schedule-due, primitives
src/ports/       interfaces: stores, brain driver, hands, kube, listener bridge, policy
src/services/    in-kernel subsystems: Agent/Home/Message/Schedule/Policy/Listener/
                 Reconciler/Syscall/SystemAgents/Projection
src/adapters/    JSON/SQLite stores, pi-SDK + test + HTTP brains,
                 LocalConfined/Container/HTTP/MCP hands, k8s clients, HTTP API
src/runtime/     LocalRuntime + DistributedRuntime (composition roots)
src/controller/  KubeController (CRDs → native k8s objects)
src/brain-pod/   the brain pod HTTP server + CLI
src/hands-pod/   the hands pod MCP server + CLI
```

## Core invariants

- Hades is a control plane, not a single tool call.
- Brains embed the pi SDK in-process; they do not spawn an RPC harness inside a sandbox.
- Brain, hands, session, listener, home, schedule, capability are separate concerns managed by one kernel.
- Self-modification goes through scoped, capability-checked `os.*` syscalls.
- Durable session/event logs outlive every brain and hands pod.
- No model credentials ever live in hands.
- Humans can inspect, steer, and talk directly to any authorized agent.

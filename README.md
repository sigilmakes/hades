# Hades

Hades is a **monolithic agent kernel**: one privileged supervisor with internal subsystems, supervising squishy agent workloads. Think Linux, not a microkernel.

There is one kernel and two kinds of agents, just like a Linux box has daemons and throwaway processes:

- **Resident agents** — long-running, privileged, trusted daemons with durable state. Wren is one.
- **Ephemeral agents** — short-lived, confined, spawned for one task and reaped after.

The kernel owns the boring, precious things: scheduling, the durable session/event logs, agent Homes, and the capability/permission system. Everything an agent needs to *do* (think, run code, talk to a channel) is a squishy workload the kernel spins up and reaps — brains, hands, gateways. Crash is not a disaster: the kernel re-wakes a brain from its durable log.

> **Status:** a coherent, tested **kernel** with the right invariants and a runnable single-process shape — **not** a deployed multi-tenant platform. Real platform listeners, Kubernetes controllers, and a real store are adapters behind ports that already exist. See `docs/architecture.md`.

## Quickstart

```bash
npm install
npm test              # 31 tests, offline
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

`./bin/hades` builds `dist/` if needed. State lives under `HADES_DATA_DIR` (default `./.hades`).

## Brains

- **`pi-sdk` (default)** — the real brain. Routes `hades_read`/`hades_write`/`hades_exec` through Hands. **Needs a working model in your environment** — Hades bundles no model and assumes none.
- **`test`** — offline directive brain for tests/demos. `HADES_BRAIN_MODE=test` or `spec.brain.mode: "test"`.

The removed `deterministic` mode and `!bash` directive fail loudly by design. Use `test` + `!exec`.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — how the system works: the monolithic-kernel + resident/ephemeral model, squishy workloads, the privilege ladder, local-vs-k8s shapes.
- [`docs/setup.md`](docs/setup.md) — honest setup: what works offline, what needs your environment, local hands confinement, schedules, where state lives.
- [`spec/`](spec/) — the full AgentOS spec set, including [`spec/15-agentos-primitives.md`](spec/15-agentos-primitives.md) (what Hades adopts, defers, rejects).

## Code shape

```text
src/domain/      resource, event, capability, sandbox, schedule-due, primitives
src/ports/       interfaces for stores, brain drivers, hands, policy
src/services/    internal kernel subsystems: Agent/Home/Message/Schedule/Policy/Listener/Reconciler/Primitive
src/adapters/    JSON/JSONL stores, pi-SDK + test brains, local confined hands, HTTP API, manifest parser
src/runtime/     local composition root
```

Subsystems are internal to the kernel, not peer servers — that is the monolithic choice. Ports exist so `LocalConfinedHands` (in-process) and a future `ContainerHands` (pod) are the same interface with different policy.

## Core invariants

- Hades is a control plane, not a pi extension and not a single tool call.
- Brains use the pi SDK in-process; they do not spawn `pi --mode rpc` inside a sandbox.
- Brain, hands, session, listener, home, schedule, capability are separate concerns — but managed by one kernel, not separate servers.
- Self-modification goes through scoped, capability-checked `os.*` syscalls: schedules, tools, listeners, child agents.
- Durable session/event logs outlive every brain and hands pod.
- No model credentials ever live in hands.
- Humans can inspect, steer, and talk directly to any authorized agent.
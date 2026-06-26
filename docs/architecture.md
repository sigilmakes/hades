# Hades Architecture

Hades is a **monolithic agent kernel**: one privileged supervisor with internal subsystems, supervising squishy agent workloads. Think Linux, not a microkernel that farms every concern out to a separate server.

## The analogue

A Linux machine has one kernel and two kinds of processes:

- **Daemons** — long-running, privileged, trusted (`sshd`, `cron`, `journald`). The system keeps them up; their state survives.
- **Throwaway processes** — short-lived, confined, spawned for one job then reaped (`grep`, a `systemd-run` transient unit).

Hades is the same shape, for agents.

| Linux | Hades |
|---|---|
| the kernel (one privileged core) | the **Hades control plane** — one logical supervisor: API, scheduler, capability/security, session/event store, controllers |
| kernel subsystems (scheduler, fs, net, caps) live *in-kernel* | Hades subsystems live *inside* the kernel, not as peer servers: `ScheduleService`, `PolicyService`, `MessageService`, `AgentService` are internal subsystems, not cooperating microservices |
| daemons (long-running, privileged) | **resident agents** — named, persistent, durable Home, scheduled wakeups, broad capabilities. Wren is a resident agent. |
| throwaway processes (short-lived, confined) | **ephemeral agents** — spawned for one task, given scratch + narrow capabilities, reaped on completion. A research subagent, a one-shot reviewer. |
| syscalls (`fork`, `socket`, `read`…) | `os.*` capability-checked syscalls: `createSchedule`, `attachListener`, `spawnAgent`, `requestHands`. **Resident agents use these as their main programming model.** Ephemeral agents barely use them — they're handed a tiny grant and do the job. |
| device drivers (loadable modules) | gateways/listeners (Discord, Matrix, web, CLI) — the kernel attaches a driver to give an agent a device/channel; squishy, load/unload |
| the timer/cron + inotify subsystem | the scheduler subsystem — kernel-owned, fires events into agent processes |
| Linux capabilities + seccomp | the capability/permission system — discrete grants gating which syscalls an agent may make; more grant = more cluster control |
| per-process fs namespace / home dir / cgroup | **Home** — the agent's persistent userland; survives process death, owned by the kernel |
| driver code runs in kernel context | **hands/sandbox** — the kernel-spawned execution context where an agent's untrusted code runs; squishy, created per-need, torn down after |

## Squishy

The defining property: **only the kernel and durable state are precious.** Everything a kernel supervises is cattle:

- **Agent brains** — spun up when an agent needs to think (a schedule fires, a message arrives), killed when idle. Crash is not a disaster: the kernel re-`wake`s the brain from the durable session log.
- **Agent hands** — sandbox/tool pods created for a tool call or work session, torn down after. No model credentials ever live here.
- **Agent gateways** — bridge pods (Discord/Matrix) attached and detached per agent like loading/unloading a driver.

You don't keep fifty agent brain pods hot. You keep the kernel hot, the durable logs and homes on disk, and you spin brains/hands/gateways only when there's work. That's what makes it cheap to run a personal agent OS on one small box.

## The privilege ladder

Capabilities scale with lifecycle class, exactly like a Linux box:

- A **resident agent** you trust runs with broad grants: it may `os.spawnAgent` (make ephemeral workers), `os.attachListener` (get a new channel), `os.createSchedule` (set its own timers), and — if you grant it — touch the cluster network or provision peers. It's a daemon you've chosen to trust.
- An **ephemeral agent** runs confined: it gets exactly the capability its spawning task needs and no more, a scratch workspace (not a full durable Home), and is reaped when the task completes. It's a transient unit.

An agent with no grants can still think and use its own Home. Granting more is a deliberate, inspectable, revocable act recorded in the event log — the OS-permission primitive.

## One kernel, two deployment shapes

The kernel is the same logical thing in both; only the squishy workloads change from in-process objects to real pods:

```text
Local prototype (today):
  one process = the kernel
    └─ brain/hands/gateway are in-process objects the kernel manages
    └─ durable state is JSON + JSONL on disk
  Good for: development, tests, single-user agents on one laptop

Kubernetes target:
  one control-plane Deployment = the kernel
    └─ brain/hands/gateway are real pods the kernel schedules and reaps
    └─ durable state is a real event/projection store + Home PVCs
  Good for: resident agents that must stay up, many agents, real isolation
```

The local prototype is **not a toy** — it is the same kernel with its workloads in-process. Code written against the kernel interfaces (services, ports) does not change when the workloads become pods. The ports exist precisely so `LocalConfinedHands` (in-process) and a future `ContainerHands` (pod) are the same interface with different policy.

## Syscalls that are real today

The full `os.*` syscall layer (spec/08), capability-checked and audited:

- `os.createSchedule` — resident agents set their own timers (cron/interval/once).
- `os.spawnAgent` — a resident agent mints a confined ephemeral worker for one task; the kernel reaps it after. In deploy mode this is a real pod (`spawnAgent` = `fork()`); the controller cascades brain/hands pod deletion via ownerReferences.
- `os.createAgent` / `os.createHome` / `os.attachListener` — provision agents, homes, and platform listeners.
- `os.requestApproval` / `os.respondApproval` — resumable human-in-the-loop gates for destructive ops.
- `os.emitArtifact` — record artifact references in the event log.

## Distributed mode (now real)

Hades now runs as a real distributed system, not just a simulation. The same kernel services run in both modes behind the same ports (D4):

- **Brain pods** lift the pi-SDK model loop into their own process (`POST /run` + SSE). Tool calls route over **MCP Streamable HTTP** to hands pods — the standards-aligned wire, not a bespoke protocol.
- **Hands pods** are MCP servers exposing `hades_read`/`hades_write`/`hades_exec`, backed by the same confinement logic (profile-driven sandbox). Model credentials never live here.
- **A k8s controller** reconciles Hades resources into native k8s objects: `Deployment`s for brains, `PVC`s for homes, `CronJob`s for schedules, `NetworkPolicy` + `RBAC` for capability projection. Uses `ownerReferences` for native GC.
- **Durable stores**: SQLite-on-PVC event + state stores (behind the port; Postgres is the prod target).
- **Node-count-agnostic**: only standard k8s API objects; single-node k3s → multi-node is a StorageClass swap, never a rewrite.

Milestone 1 (proven): one agent end-to-end over HTTP — controller reconciles the manifest, a real brain pod runs, tool calls cross MCP to a hands pod, the home PVC persists, and the agent survives a brain pod restart.

## System agents

Three privileged userland daemons (spec/12) are bootstrapped on reconcile: **provisioner** (creates agents/homes/listeners), **janitor** (cleans expired resources), **auditor** (reviews policy/exposure). They are agents with scoped capabilities, never blanket cluster-admin — intelligent operators on top of the deterministic controller.

## What is NOT here (honest gaps)

- **Real model run**: the brain's pi-SDK path is wired but only exercised by an offline test brain. Running a real model depends on your environment's providers/keys; there is no bundled "clean" model path. See `docs/setup.md`.
- **Real platform listener bridges**: the CLI bridge is real (`hades attach`); Discord/Matrix/email bridges are declared resources with the routing contract in place, but their platform SDKs are not wired (they throw on start — the resource model exists, the SDK is the missing piece).
- **Real cluster deployment**: the controller is tested against a `FakeKubeClient`; a `@kubernetes/client-node`-backed client for a live cluster is the deploy concern. The controller logic is what's under test; cluster wiring is configuration.
- **Projections/UI**: raw events are durable and queryable; the projection store (AgentTree, RunSummary) is out of scope until there's a UI.

Hades today is a coherent, tested **distributed agent OS** with the right invariants — pod-per-agent, everything over HTTP, capability-checked self-modification, durable state, and native-k8s reconciliation. The remaining work is platform adapters (real listeners, a live cluster client) behind the ports that already exist.

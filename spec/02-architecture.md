# 02 — Architecture

Hades is a **monolithic agent kernel**: one privileged supervisor with internal
subsystems, supervising squishy agent workloads. Think Linux, not a microkernel
that farms every concern out to a separate server.

## The kernel and its workloads

```mermaid
flowchart TB
    subgraph kernel["Hades kernel (one logical supervisor)"]
        direction LR
        API["API server"]
        REC["Reconciler"]
        SVC["services:<br/>Agent · Home · Message · Schedule ·<br/>Policy · Listener · Syscall · Projection"]
    end

    subgraph durable["Durable state (precious)"]
        SS["StateStore"]
        ES["EventStore"]
        HOMES["Home PVCs"]
    end

    subgraph cattle["Workloads (cattle)"]
        BRAIN["brain pods"]
        HANDS["hands pods"]
        L["listener pods"]
    end

    API --> SVC
    SVC --> REC
    SVC --> SS
    SVC --> ES
    SVC --> HOMES
    REC -->|reconcile into| cattle
    BRAIN -->|MCP tools| HANDS
    HANDS -->|read/write/exec| HOMES
```

The kernel subsystems (`AgentService`, `HomeService`, `MessageService`,
`ScheduleService`, `PolicyService`, `ListenerService`, `SyscallService`,
`ProjectionService`) live **inside** the kernel — they are internal modules,
not cooperating microservices. The only things that are separate processes are
the squishy workloads: brains, hands, listeners.

## Resident vs ephemeral

```mermaid
flowchart LR
    subgraph res["Resident agent"]
        R1["durable identity"]
        R2["persistent Home"]
        R3["broad capabilities"]
        R4["scheduled wakeups"]
    end
    subgraph eph["Ephemeral agent"]
        E1["spawned for one task"]
        E2["scratch + narrow grant"]
        E3["reaped on completion"]
    end
    SPAWN["os.spawnAgent"] --> eph
    R1 --> SPAWN
```

| Linux | Hades |
|-------|-------|
| the kernel | the control plane — API, reconciler, policy, stores |
| kernel subsystems (scheduler, fs, net, caps) | Hades services, in-kernel |
| daemons (long-running, privileged) | **resident agents** — Atlas is one |
| throwaway processes (short-lived, confined) | **ephemeral agents** — a research subagent |
| syscalls (`fork`, `socket`, `read`) | `os.*` capability-checked syscalls |
| device drivers (loadable modules) | listener bridges (Discord/Matrix/CLI) |
| Linux capabilities + seccomp | the capability/permission system |
| per-process home dir / cgroup | **Home** — persistent agent userland |
| driver code in kernel context | **hands** — the sandbox where untrusted code runs |

## One runtime, swappable adapters

Hades is one k8s-native kernel. There is no "dev mode" or "deploy mode" —
brains and hands are pods. The kernel services depend on **ports**, never on
concrete adapters; the composition root (`createRuntime`) selects which
adapters satisfy the ports. In-process adapters exist only as a test substrate
(they let the kernel run without a cluster); a live cluster injects pod-backed
adapters through the same options.

```mermaid
flowchart LR
    KERNEL["HadesRuntime<br/>(one kernel, same services)"]
    subgraph test["test substrate (in-process)"]
        T1["in-process brain/hands"]
        T2["sqlite on disk"]
    end
    subgraph live["live cluster (pods)"]
        L1["brain pods + hands pods"]
        L2["sqlite on PVC / Postgres"]
        L3["KubeController"]
    end
    KERNEL --> test
    KERNEL --> live
```

| Concern | Test substrate | Live cluster |
|---------|----------------|--------------|
| brain | in-process `PiSdkBrainDriver` | `HttpBrainDriver` → brain pod |
| hands | in-process `LocalConfinedHands` | `PodHandsBackend` → exec into hands pod |
| state | `JsonStateStore` | `SqliteStateStore` (Postgres target) |
| events | `JsonlEventStore` | `SqliteEventStore` |
| reconcile | in-process `Reconciler` | + `KubeController` → native k8s objects |

Dev runs the live-cluster path against a local kind cluster via Tilt. The
in-process adapters are test injections, not a runtime variant.

## The privilege ladder

```mermaid
flowchart TD
    SYS["system agents<br/>provisioner · janitor · auditor<br/>(scoped elevated grants)"]
    RES["resident agents<br/>broad grants: spawn, schedule,<br/>listeners, approvals"]
    EPH["ephemeral agents<br/>exactly the capability<br/>their task needs"]
    SYS --> RES --> EPH
```

- A **resident agent** you trust runs with broad grants: `os.spawnAgent`,
  `os.attachListener`, `os.createSchedule`, and — if granted — touch the cluster.
- An **ephemeral agent** runs confined: it gets exactly the capability its
  spawning task needs, a scratch workspace, and is reaped on completion.
- A **system agent** (provisioner/janitor/auditor) is a resident agent with an
  elevated but scoped grant — never blanket cluster-admin.

Granting more is a deliberate, inspectable, revocable act recorded in the event
log — the OS-permission primitive.

## Code shape

```text
src/domain/      resource, event, capability, sandbox, schedule-due, primitives
src/ports/       interfaces: stores, brain driver, hands, kube, listener bridge, policy
src/services/    in-kernel subsystems: Agent/Home/Message/Schedule/Policy/
                 Listener/Reconciler/Syscall/SystemAgents/Projection
src/adapters/    JSON/SQLite stores, pi-SDK + test + HTTP brains,
                 LocalConfined/Container/HTTP/MCP hands, k8s clients, HTTP API
src/runtime/     HadesRuntime (the composition root) + Runtime base
src/controller/  KubeController (CRDs → native k8s objects)
src/brain-pod/   the brain pod HTTP server + CLI
src/hands-pod/   the hands pod MCP server + CLI
```

Subsystems are internal to the kernel, not peer servers — that is the
monolithic choice. Ports exist so `LocalConfinedHands` (in-process, no
isolation) and `ContainerHands` (docker isolation) are the same interface with
different policy.

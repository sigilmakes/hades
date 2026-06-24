# Hades Spec Index

Hades is an agent operating system on Kubernetes. It provides a small, boring kernel and lets rich agent userlands grow on top.

## Hard Decisions

1. **Kubernetes is mandatory.** Local development uses k3s/kind/k3d, not a bespoke daemon that later grows Kubernetes.
2. **Hades is a control plane.** Pi, Discord, web, CLI, and CI are clients or runtime integrations, not the host.
3. **Brains use the pi SDK.** Brain pods embed pi SDK sessions directly. RPC mode is for external clients, not the primary harness.
4. **Brain and hands are separate.** Model/harness credentials never live in tool sandboxes.
5. **Agents have userland.** Homes, tools, crons, skills, and vaults are mutable contents owned by agents.
6. **Listeners are per-agent devices.** Agent A can have Discord+Matrix; Agent B can have Email+Discord; all are declared resources.
7. **Schedules are first-class.** Self-authored cron/timer jobs are part of agent autonomy.
8. **Session/event log is durable truth.** Model context, pod filesystems, projections, and dashboards are caches.
9. **Self-modification is allowed through capabilities.** Agents may create schedules, tools, homes, child agents, and listeners only through policy-checked OS APIs.
10. **The kernel stays boring.** Intelligence belongs in agents and system agents; controllers reconcile resources.

## Documents

- [`01-thesis.md`](01-thesis.md) — product thesis and rejection of hidden tool-call orchestration.
- [`02-ontology.md`](02-ontology.md) — OS object model: agent, home, session, listener, schedule, hands, tools, capabilities.
- [`03-kubernetes-model.md`](03-kubernetes-model.md) — namespaces, CRDs, controllers, pods, volumes, and object graph.
- [`04-brain-and-session.md`](04-brain-and-session.md) — pi SDK brain pods, durable logs, wake/sleep, context management.
- [`05-hands-and-tools.md`](05-hands-and-tools.md) — disposable hands, sandbox execution, tool routing, custom tools.
- [`06-listeners-and-io.md`](06-listeners-and-io.md) — per-agent Discord/Matrix/email/web/CLI listeners and routing.
- [`07-schedules-and-userland.md`](07-schedules-and-userland.md) — cron, agent homes, self-modification, Wren-style userland.
- [`08-control-plane.md`](08-control-plane.md) — API server, controllers, scheduler, event/projection stores.
- [`09-security-and-policy.md`](09-security-and-policy.md) — capabilities, secrets, RBAC, network policy, approvals, audit.
- [`10-protocols-and-apis.md`](10-protocols-and-apis.md) — ACP/A2A compatibility, Hades APIs, syscalls, event schemas.
- [`11-ui-ux.md`](11-ui-ux.md) — control-room UX, direct agent rooms, listener/hands/schedule views.
- [`12-system-agents.md`](12-system-agents.md) — provisioner, janitor, auditor, librarian, backup, and recursive agents.
- [`13-v0-loop.md`](13-v0-loop.md) — smallest end-to-end loop that proves Hades should exist.
- [`14-build-vs-borrow.md`](14-build-vs-borrow.md) — what Hades builds, borrows, and avoids.
- [`15-agentos-primitives.md`](15-agentos-primitives.md) — useful OS/gateway/tool/workflow primitives versus noise.

## One-Screen Architecture

```text
                         ┌────────────────────────────────────┐
                         │ Humans / Apps / CI / Agents        │
                         │ web tui cli discord matrix email   │
                         └──────────────────┬─────────────────┘
                                            │
                                            v
┌──────────────────────────────────────────────────────────────────────────────┐
│                              HADES KERNEL                                    │
│                                                                              │
│  API Server        Controllers        Scheduler        Event Store           │
│  ACP/Hades APIs    reconcile CRDs     placement       durable truth          │
│                                                                              │
│  Secret Broker     Policy Engine      Projection Bus   System Agents         │
│  no raw sandbox    capabilities       UI state         provision/janitor     │
└──────────┬────────────────┬────────────────┬─────────────────────┬──────────┘
           │                │                │                     │
           v                v                v                     v
┌────────────────┐  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐
│ Brain Pods     │  │ Hands Pods     │  │ Listener Pods  │  │ Home PVCs      │
│ pi SDK loops   │  │ sandboxes      │  │ Discord/email  │  │ vault/bin/cron │
│ no tool creds  │  │ no brain creds │  │ per agent      │  │ userland       │
└────────────────┘  └────────────────┘  └────────────────┘  └────────────────┘
```

## First Prototype Definition of Done

```text
[ ] local k3s/kind install from a clean machine
[ ] Hades API exposes /agents, /runs, /sessions, /events, /approvals
[ ] one Agent resource creates/wakes a pi SDK brain pod
[ ] one Home resource mounts persistent vault/bin/cron.d into approved hands
[ ] one Listener resource attaches Discord or CLI to one agent
[ ] one Schedule resource fires a prompt into one agent
[ ] brain calls bash/read/write through a hands pod, not locally
[ ] brain crash recovers from session log
[ ] hands crash becomes a tool error, not agent death
[ ] human can directly message a selected agent
[ ] agent can create a new schedule through a policy-checked syscall
[ ] all state is inspectable via Hades API and kubectl
```

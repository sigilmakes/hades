# Hades Spec Index

Hades is a Kubernetes-native agent operating system. It coordinates AI agents through a central control plane, ACP-compatible communication, durable event logs, and a strict separation between reasoning brains and execution hands.

## Hard Decisions

1. **Kubernetes is mandatory.** Even the smallest local deployment targets k3s/kind/k3d rather than a bespoke tmux-only daemon.
2. **Hades is a control plane, not a pi extension.** Pi-the-app may become a client, but orchestration must live outside any one chat session.
3. **Build on the pi SDK, not pi TUI internals.** Brain pods use SDK sessions/harness APIs directly.
4. **ACP is the agent wire protocol.** Hades exposes ACP endpoints and extends them with management APIs.
5. **Brain and hands are separate.** The harness/model loop does not live inside the tool sandbox.
6. **The session/event log is durable truth.** Brains and hands are replaceable cattle.
7. **Direct subagent communication is required.** Selecting an agent in the UI must let the human talk directly to it.

## Documents

- [`01-thesis.md`](01-thesis.md) — product thesis, non-goals, and why tool-call orchestration is the wrong abstraction.
- [`02-foundations.md`](02-foundations.md) — synthesis of ACP, Anthropic managed agents, pi SDK, and Kubernetes.
- [`03-kubernetes-model.md`](03-kubernetes-model.md) — namespaces, CRDs, controllers, pods, storage, and scheduling.
- [`04-brain-hands.md`](04-brain-hands.md) — brain pod / hands pod split, lifecycle, sharing, and failure handling.
- [`05-control-plane.md`](05-control-plane.md) — Hades API server, controller loops, event store, and reconciliation model.
- [`06-protocols-and-apis.md`](06-protocols-and-apis.md) — ACP endpoints plus Hades management APIs and event schemas.
- [`07-ui-ux.md`](07-ui-ux.md) — API-first UX model and KAOS-inspired web frontend with extensive ASCII mockups.
- [`08-security-and-policy.md`](08-security-and-policy.md) — credentials, sandboxing, RBAC, network policy, audit, and isolation.
- [`09-rollout.md`](09-rollout.md) — implementation phases from local k3s prototype to distributed clusters.
- [`10-platform-landscape.md`](10-platform-landscape.md) — comparison of kagent, KAOS, Agent Sandbox, Kelos, Orka, Ark, and Kagenti.
- [`11-microsoft-reference-architecture.md`](11-microsoft-reference-architecture.md) — analysis of Microsoft’s multi-agent reference architecture and mapping to candidate platforms.
- [`12-programmatic-subagents.md`](12-programmatic-subagents.md) — re-ranking on the programmatic subagent spawning axis (Orka vs kagent vs Kelos).
- [`13-build-vs-borrow.md`](13-build-vs-borrow.md) — decision to build Hades, but only the differentiating core over existing primitives.

## One-Screen Architecture

```text
                                ┌──────────────────┐
                                │ Human / Apps     │
                                │ TUI Web CLI ACP  │
                                └────────┬─────────┘
                                         │
                                         v
┌────────────────────────────────────────────────────────────────────────────┐
│                             HADES CONTROL PLANE                            │
│                                                                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ API Server   │  │ Scheduler    │  │ Controllers  │  │ Event Store   │  │
│  │ ACP + Hades  │  │ placement    │  │ reconcile    │  │ durable log   │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘  │
└─────────┼─────────────────┼─────────────────┼──────────────────┼──────────┘
          │                 │                 │                  │
          v                 v                 v                  v
┌────────────────────────────────────────────────────────────────────────────┐
│                              KUBERNETES                                    │
│                                                                            │
│   ┌────────────────┐      ┌────────────────┐      ┌────────────────┐      │
│   │ Brain Pod      │      │ Brain Pod      │      │ Brain Pod      │      │
│   │ planner        │      │ coder          │      │ reviewer       │      │
│   │ pi SDK harness │      │ pi SDK harness │      │ pi SDK harness │      │
│   └───────┬────────┘      └───────┬────────┘      └───────┬────────┘      │
│           │                       │                       │               │
│           └───────────────┬───────┴──────────────┬────────┘               │
│                           v                      v                        │
│                 ┌────────────────┐      ┌────────────────┐                │
│                 │ Hands Pod      │      │ Hands Pod      │                │
│                 │ repo/toolbox   │      │ browser/mcp    │                │
│                 │ disposable     │      │ disposable     │                │
│                 └────────────────┘      └────────────────┘                │
└────────────────────────────────────────────────────────────────────────────┘
```

## Definition of Done for the First Real Prototype

```text
[ ] k3s/kind local install works from a clean machine
[ ] Hades API exposes ACP /agents and /runs
[ ] A brain pod can run a pi SDK session
[ ] A hands pod can execute shell/read/write/test calls for a brain
[ ] Brain crash recovers from durable session log
[ ] Hands crash becomes a tool error, not agent death
[ ] Human can directly message a selected agent
[ ] Web frontend shows real hierarchy, tasks, activity, stats, approvals, logs, YAML, and direct agent chat
[ ] All state can be inspected through API and kubectl
```

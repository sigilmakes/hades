# 13 — Decision: Build Hades, But Only the Novel Core

## Status

Decision: **build Hades as our own project**, but build only the differentiating core and stand on existing primitives for everything else.

This supersedes the "contribute to kagent, don't greenfield" recommendation in `10-platform-landscape.md` for the specific system Willow wants. Contributing upstream remains a *secondary* option for non-novel pieces.

## Why the Gap Is Real

The target system has three structural properties that no reviewed platform combines:

1. **Strict brain/hands separation** following Anthropic Managed Agents:
   - brain pod = stateless harness that wakes from a durable event log
   - hands pod = disposable tool/sandbox called as `execute(name, input) -> string`
   - session/event log = durable truth outside both

   No candidate does this. kagent's agent pod *is* the ADK harness+runtime. Orka and Kelos put the harness inside the worker/task pod. This is architectural, not a missing feature.

2. **Programmatic subagent spawning with guardrails as a first-class control-plane primitive.**
   Only Orka has this, and Orka has very low adoption and does not separate brain from hands.

3. **pi SDK as a first-class brain runtime.**
   No platform targets pi. This is Willow's alone.

Additionally, the desired UX — direct agent room, live subagent tree, hands attach, cross-tree approvals — is not prioritized by any candidate.

Therefore "contribute to kagent" has a ceiling: imposing brain/hands separation on kagent would be a rewrite of its core agent-pod model, not a contribution.

## What We Build vs What We Borrow

### Build ourselves (the differentiating core)

```text
Control plane
    API server (ACP + Hades management APIs)
    controller manager
    CRDs: AgentClass, AgentSession, AgentRun, HandsPod, Workspace, Approval, Artifact
    scheduler/placement logic
    guardrails: maxDepth, allowedClasses, maxConcurrentChildren

Runtime model
    brain pod runtime that wakes from session log, runs pi SDK, routes tools to hands
    hands pod adapter contract
    event/session store and projections
    programmatic spawn/resume/cancel APIs
    approval/await/resume flow
    direct-message-to-agent routing

Brain runtime
    pi SDK adapter as a first-class brain implementation

UX
    web frontend (KAOS-inspired) over the API
    direct agent room
    live subagent tree
    hands room + terminal attach
    approval queue
    event replay
```

### Borrow / depend on (do not reinvent)

```text
Kubernetes Agent Sandbox      hands/tool pod substrate
A2A / ACP                     agent wire protocol
MCP                           tool protocol
kubebuilder / controller-runtime   controller scaffolding
Postgres                      event/projection store
OpenTelemetry                 traces/metrics/logs
KMCP / kagent MCP patterns    tool server model (reference only)
gVisor / Kata                 hands isolation runtimes
```

## Anti-Pattern to Avoid

Do not repeat Styx: building logs, worktrees, signatures, limiter, sandbox, orchestrator, and UI as one bespoke tower with no substrate reuse. Hades must be a thin novel core over Kubernetes + Agent Sandbox + A2A/ACP + MCP + Postgres + OTel.

## Risk

Solo Kubernetes agent OS is a large surface. Mitigations:

```text
- Build the thinnest spine first; prove one loop; then grow.
- Reuse primitives aggressively.
- Keep CRDs minimal until a loop forces a field to exist.
- Do not build UI breadth until the API loop is proven.
- Do not build multi-tenancy, federation, or k8s-at-scale until local k3s loop is solid.
```

## The One Loop to Prove First

```text
local k3s
  → Hades API: POST /runs from an AgentClass
  → controller wakes a brain pod (pi SDK)
  → brain reads session events, calls model
  → brain calls execute(tool) on an Agent Sandbox hands pod
  → hands returns result
  → brain emits event, may await approval
  → human can directly message the brain via API/UI
  → run completes, events durable
  → brain crash recovers from event log
  → hands crash becomes a tool error, not agent death
```

If this loop works on k3s with a real model, Hades has a reason to exist. If it does not, stop.

## Minimal First Build

```text
hades-api          ACP + Hades /runs /agents /sessions /events /approvals
hades-controller   AgentSession/AgentRun/HandsPod/Workspace reconciliation
hades-brain        pi SDK brain runtime container
hades-hands        Agent Sandbox-backed tool pod (bash/read/edit/git/test)
hades-store        Postgres event/session store + projections
hades-ui           web frontend over API (start: runs list, agent room, approvals)
hades-cli          install/run/inspect
```

Everything else in the spec (scheduler, budget, federation, eval harness, artifact store, RBAC breadth, web scale) is deferred until the one loop is proven.

## Relationship to Upstream

- Kubernetes Agent Sandbox: use as a dependency; contribute fixes if needed.
- A2A/ACP/MCP: implement as a client/server; contribute protocol feedback if found.
- kagent: not a base; borrow MCP/tool-server and HITL ideas where applicable.
- Orka: borrow the programmatic spawn + guardrails model explicitly.
- KAOS: borrow UI/product taste.
- Kelos: borrow workspace/credential/token-refresh lessons.
- Ark: borrow aggregated API/Postgres scalability lessons when scale matters.
- Kagenti: borrow security/identity lessons when hardening matters.

## Success Criteria for the First Prototype

```text
[ ] k3s install from clean machine
[ ] ACP /agents and /runs work
[ ] brain pod runs a pi SDK session with a real model
[ ] hands pod executes shell/read/write for the brain via Agent Sandbox
[ ] brain crash recovers from durable session log
[ ] hands crash becomes a tool error, agent continues
[ ] human can directly message a selected agent
[ ] web UI shows run tree, agent room, approvals, event replay
[ ] programmatic spawn of a child run with maxDepth enforced
[ ] all state inspectable via API and kubectl
```
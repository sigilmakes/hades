# 02 — Foundations: ACP, Managed Agents, Pi SDK, Kubernetes

Hades combines four foundations:

1. ACP for inter-agent communication.
2. Anthropic managed-agents architecture for brain/hands/session decoupling.
3. Pi SDK for agent brain/harness execution.
4. Kubernetes for runtime scheduling, isolation, and lifecycle.

## ACP Foundation

ACP defines a RESTful protocol for agent interoperability.

Important primitives:

```text
GET  /agents
GET  /agents/{agent_name}
POST /runs
GET  /runs/{run_id}
GET  /runs/{run_id}/events
POST /runs/{run_id}
POST /runs/{run_id}/cancel
GET  /sessions/{session_id}
```

ACP run lifecycle:

```text
created
   |
   v
in-progress
   |       \
   |        \ needs input / approval / external response
   |         v
   |      awaiting ---- resume ----+
   |                               |
   v                               v
completed / failed / cancelled / cancelling
```

ACP message shape is multi-modal and MIME-typed:

```json
{
  "role": "agent/planner",
  "parts": [
    {
      "content_type": "text/plain",
      "content": "I need approval to modify the auth flow."
    }
  ]
}
```

Hades should expose ACP for interoperability, but ACP alone is not enough. ACP does not define Kubernetes placement, brain/hands separation, workspace policy, full dashboard state, or cluster control loops. Hades adds those.

## Managed Agents Foundation

Anthropic's managed-agents architecture separates:

```text
session = append-only durable event log
brain   = model + harness loop
hands   = sandbox/tools/execution environment
```

The key insight:

```text
Do not put the harness inside the same container as the sandbox.
```

Old coupled model:

```text
┌────────────────────────────────────┐
│ One Container                       │
│                                    │
│  session state                     │
│  model harness                     │
│  shell/tools/repo                  │
│  user data                         │
│  generated code                    │
└────────────────────────────────────┘
```

Failure modes:

```text
- container dies => session dies
- sandbox hangs => harness hangs
- generated code sees credentials
- debugging requires shelling into user-data container
- every brain waits for full sandbox provisioning
- harness assumes resources are local
```

Decoupled model:

```text
                 ┌───────────────────────┐
                 │ Durable Session Log    │
                 └───────────┬───────────┘
                             │ wake(sessionId)
                             v
┌────────────────────────────────────────────────────────┐
│ Brain Pod                                               │
│ pi SDK session + harness + context selection            │
│ no repo clone, no user data sandbox, no raw credentials │
└──────────────────────┬─────────────────────────────────┘
                       │ execute(name, input)
                       v
┌────────────────────────────────────────────────────────┐
│ Hands Pod                                               │
│ shell, repo, worktree, tools, browser, MCP servers      │
│ disposable / replaceable / shareable                    │
└────────────────────────────────────────────────────────┘
```

Benefits:

```text
- brain crash recovers from session log
- hands crash becomes tool error
- hands can be reprovisioned
- many brains can share one hands pod
- one brain can use many hands pods
- credentials stay behind brokers/proxies
- time-to-first-token improves because brains need not wait for tools
```

## Pi SDK Foundation

Hades should use pi SDK/session APIs directly inside brain pods.

Pi-the-app is an interactive client and TUI. Hades is a control plane. Therefore Hades should not be implemented as a pi extension.

Correct dependency direction:

```text
Hades Brain Pod
    |
    +-- pi SDK session/harness APIs
    +-- model/provider configuration
    +-- tool adapters that call Hades hands services
    +-- event emitter back to Hades API
```

Incorrect dependency direction:

```text
Pi TUI
    |
    +-- Hades extension
          |
          +-- tool call pretending to orchestrate everything
```

A pi client may still exist:

```text
Pi TUI
    |
    +-- Hades client/skill
          |
          +-- ask Hades to spawn agents
          +-- talk to selected agents
          +-- open dashboard
```

But that client is not the host.

## Kubernetes Foundation

Kubernetes gives Hades the operating-system substrate:

```text
Pods              brain/hands runtime units
Services          stable network addresses
Namespaces        project/tenant isolation
CRDs              Hades resource model
Controllers       reconciliation loops
Jobs              finite agent/task runs
Deployments       API/controller replicas
StatefulSets      storage services when needed
PVCs              workspaces and caches
Secrets           references to secret brokers, not raw sandbox creds
RBAC              user/agent permissions
NetworkPolicy     tool/network isolation
Events            infrastructure observability
```

Hades does not merely run on Kubernetes. Hades thinks in Kubernetes.

## Combined Stack

```text
┌──────────────────────────────────────────────────────────────────────┐
│                              Clients                                 │
│  hades tui       hades cli       web UI       ACP clients       pi    │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │
                                   v
┌──────────────────────────────────────────────────────────────────────┐
│                         Hades API Server                             │
│  ACP endpoints | Hades management APIs | auth | dashboard projection  │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │
                                   v
┌──────────────────────────────────────────────────────────────────────┐
│                    Hades Controllers + Scheduler                     │
│  reconcile CRDs | place pods | manage workspaces | recover sessions   │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │
                                   v
┌──────────────────────────────────────────────────────────────────────┐
│                             Kubernetes                               │
│  brain pods | hands pods | services | PVCs | policies | jobs          │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │
                                   v
┌──────────────────────────────────────────────────────────────────────┐
│                         Durable Substrate                            │
│  Postgres event store | object artifacts | vault | git remotes         │
└──────────────────────────────────────────────────────────────────────┘
```

## Key Interface Boundaries

### Brain ↔ Session Log

```text
getEvents(sessionId, range/filter)
emitEvent(sessionId, event)
checkpoint(sessionId, cursor)
wake(sessionId)
sleep(sessionId)
```

### Brain ↔ Hands

```text
execute(handRef, toolName, input) -> result
stream(handRef, command) -> events
provisionHand(spec) -> handRef
releaseHand(handRef)
```

### Human ↔ Agent

```text
message(agentRef, message)
resume(runRef, awaitResume)
cancel(runRef)
attach(agentRef | handRef)
```

### Agent ↔ Agent

ACP messages/runs over Hades API.

```text
agent/planner -> POST /runs agent_name=coder
agent/coder   -> run.awaiting
agent/planner -> POST /runs/{id} await_resume=...
```

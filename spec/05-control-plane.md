# 05 — Control Plane

Hades is a control plane for agent compute. The control plane owns desired state, lifecycle, routing, policy, and observability.

## Components

```text
┌────────────────────────────────────────────────────────────────────────────┐
│                              HADES CONTROL PLANE                           │
│                                                                            │
│  ┌────────────────┐   ┌────────────────┐   ┌───────────────────────────┐  │
│  │ API Server     │   │ Controller Mgr │   │ Scheduler                 │  │
│  │ ACP + Hades    │   │ reconciliation │   │ placement + resources     │  │
│  └───────┬────────┘   └───────┬────────┘   └─────────────┬─────────────┘  │
│          │                    │                          │                │
│  ┌───────▼────────────────────▼──────────────────────────▼─────────────┐  │
│  │ Event Store / Session Store / Projection Store                       │  │
│  └───────┬────────────────────┬──────────────────────────┬─────────────┘  │
│          │                    │                          │                │
│  ┌───────▼────────┐   ┌───────▼────────┐   ┌─────────────▼─────────────┐  │
│  │ Artifact Store │   │ Vault/Broker   │   │ Dashboard Projector        │  │
│  └────────────────┘   └────────────────┘   └───────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
```

## API Server

The API server exposes:

1. ACP endpoints for interoperability.
2. Hades management endpoints for cluster control.
3. WebSocket/SSE event streams for dashboard/clients.
4. Auth/RBAC enforcement.
5. Projections optimized for UI.

It should be horizontally scalable and stateless except for connections.

```text
        ┌──────────────┐
        │ LoadBalancer │
        └──────┬───────┘
               │
     ┌─────────┼─────────┐
     v         v         v
hades-api-1 hades-api-2 hades-api-3
     │         │         │
     └─────────┼─────────┘
               v
         Event Store
```

## Controller Manager

The controller manager reconciles Hades CRDs and Kubernetes resources.

Controllers:

```text
AgentSessionController
BrainPodController
HandsPodController
WorkspaceController
AgentRunController
ApprovalController
ArtifactController
BudgetController
GarbageCollectionController
```

Reconciliation pattern:

```text
observe actual state
compare to desired state
take idempotent action
emit event
update status
repeat
```

Example:

```text
Desired:
    AgentSession/planner desiredState=active
Actual:
    no brain pod exists
Action:
    create BrainPodBinding + Kubernetes Pod
Event:
    brain.provisioning
Status:
    AgentSession.phase=waking
```

## Scheduler

The scheduler is Hades-specific. Kubernetes schedules pods to nodes, but Hades schedules agent resources to logical execution environments.

Inputs:

```text
- AgentClass
- requested task/run
- workspace requirements
- model policy
- tool policy
- resource budgets
- current cluster load
- hands pod availability
- cache/workspace locality
- isolation requirements
```

Outputs:

```text
- AgentSession selection or creation
- BrainPodBinding spec
- HandsPod selection or creation
- Workspace binding
- NetworkPolicy/RBAC policy
- budget reservations
```

Scheduling example:

```text
Task: implement auth refresh fix

Hades Scheduler:
    choose AgentClass=coder
    choose model=openai-codex/gpt-5.4-mini
    require writable worktree
    create Workspace/wt-auth-coder-001
    create HandsPod/repo-auth-coder-001 sharing=exclusive-worktree
    wake AgentSession/coder-auth-001
```

## Event Store

The event store is the heart of Hades.

Requirements:

```text
- append-only event log
- ordered per session
- queryable by session, run, agent, type, time
- supports streaming subscribers
- durable and backed up
- can store compact projections but never loses raw events
```

Event shape:

```json
{
  "id": "evt_00000128",
  "session_id": "sess_planner_auth_001",
  "run_id": "run_plan_auth_flow",
  "agent_ref": "agent/planner-auth-001",
  "type": "approval.requested",
  "created_at": "2026-06-21T12:34:10Z",
  "payload": {
    "approval_ref": "approval-17",
    "prompt": "Allow planner to modify the auth flow?"
  },
  "causality": {
    "parent_event_id": "evt_00000127",
    "trace_id": "trace_auth_redesign"
  }
}
```

## Projection Store

The dashboard should not reconstruct all state from raw events on every frame. Hades should maintain projections:

```text
RunSummary
AgentTree
TaskGraph
ActivityTail
CostSummary
ApprovalQueue
WorkspaceSummary
HandsSummary
```

Projection flow:

```text
raw events
   │
   v
projectors
   │
   ├─ dashboard state
   ├─ API list responses
   ├─ search indexes
   └─ metrics
```

Raw events remain authoritative.

## Control Loop Example

Starting a new run:

```text
Client POST /runs agent_name=planner
        │
        v
API validates ACP request
        │
        v
create AgentRun CRD + append run.created
        │
        v
AgentRunController ensures AgentSession active
        │
        v
AgentSessionController creates BrainPodBinding
        │
        v
Brain pod starts and wakes session
        │
        v
brain emits run.in-progress
        │
        v
model produces messages/tool requests
        │
        v
hands execute tools
        │
        v
brain emits run.completed / run.awaiting / run.failed
```

## Sleeping and Waking Agents

Agents should not need live pods when idle.

```text
active brain pod
    |
    | idle timeout or explicit sleep
    v
checkpoint event cursor
terminate brain pod
AgentSession remains
    |
    | new message/run
    v
new brain pod
wake(sessionId)
read events
continue
```

ASCII:

```text
┌───────────────┐          sleep           ┌───────────────┐
│ Agent active  │ ───────────────────────> │ Agent sleeping│
│ brain pod yes │                          │ brain pod no  │
└───────┬───────┘                          └───────┬───────┘
        │                                          │
        │ event log persists                       │ message arrives
        v                                          v
┌────────────────────────────────────────────────────────────┐
│ Durable AgentSession + Session Log                         │
└────────────────────────────────────────────────────────────┘
```

## Direct Message Routing

A human or agent can message any authorized agent.

```text
POST /hades/agents/{agentRef}/messages
        │
        ├─ if agent sleeping: wake it
        ├─ append message.created
        ├─ deliver to brain inbox
        └─ stream resulting events
```

If the target run is `awaiting`, message may become an ACP resume:

```text
POST /runs/{run_id}
{
  "await_resume": {
    "message": { ... }
  },
  "mode": "stream"
}
```

## Tool Routing

Brain pods do not execute shell commands directly. They call Hades tool routing.

```text
Brain tool call
    |
    v
Hades API / tool router
    |
    ├─ authorize tool call
    ├─ select hands pod
    ├─ stream command/result events
    └─ return result/error to brain
```

This makes tool execution observable, rate-limited, policy-enforced, and decoupled.

## Observability

Hades should emit:

```text
- Kubernetes events
- OpenTelemetry traces
- structured logs
- Prometheus metrics
- event-store audit records
```

Trace propagation:

```text
user request
  -> ACP run
    -> brain model call
      -> tool request
        -> hands command
          -> artifact
```

Metrics:

```text
hades_agents_active
hades_brain_pods_running
hades_hands_pods_ready
hades_runs_in_progress
hades_runs_awaiting
hades_tool_calls_total
hades_tool_call_duration_seconds
hades_model_tokens_total
hades_model_cost_total
hades_approval_age_seconds
```

## Garbage Collection

GC must be explicit and policy-driven.

Objects with TTL:

```text
- completed AgentRuns
- idle brain pods
- idle hands pods
- ephemeral workspaces
- old artifacts
- old projections
```

Objects never silently removed:

```text
- raw event logs unless retention policy says so
- artifacts marked retained
- workspaces with unmerged changes
- approvals/audit records
```

# 08 — Control Plane

Hades is a control plane. It owns desired state, lifecycle, routing, policy, and observability.

## Components

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ HADES CONTROL PLANE                                                        │
│                                                                            │
│ API Server        Controller Manager        Scheduler                      │
│ Event Store       Projection Store          Secret Broker                  │
│ Policy Engine     Artifact Store            System Agents                  │
└────────────────────────────────────────────────────────────────────────────┘
```

## API Server

Exposes:

```text
ACP/A2A-compatible agent endpoints
Hades management APIs
OS syscalls for agents
WebSocket/SSE streams
UI projections
authn/authz enforcement
```

It should be stateless except open streams.

## Controller Manager

Controllers reconcile CRDs into pods, PVCs, services, policies, and events.

```text
observe actual state
compare desired state
take idempotent action
emit event
update status
repeat
```

## Scheduler

The Hades scheduler decides logical placement, not node placement.

Inputs:

```text
agent class
model policy
hands requirements
home/workspace locality
capabilities
budget
cluster load
listener/session state
```

Outputs:

```text
brain binding
hands selection/provisioning
workspace binding
policy projections
budget reservation
```

## Event Store

Requirements:

```text
append-only raw events
ordered per session
query by session/run/agent/type/time
stream subscribers
durable backups
never lose raw events when projections change
```

Prototype can use Postgres. SQLite-on-PVC is acceptable only for throwaway local experiments.

## Projection Store

The UI should not replay every raw event on every frame. Maintain projections:

```text
AgentTree
RunSummary
ActivityTail
ApprovalQueue
ListenerStatus
ScheduleStatus
HandsSummary
HomeSummary
CostSummary
```

Raw events remain authoritative.

## OS Syscall Layer

Agents should not patch raw Kubernetes YAML by default. They call typed Hades APIs:

```text
os.createSchedule
os.updateHomeFile
os.createTool
os.spawnAgent
os.attachListener
os.createHands
os.requestApproval
os.emitArtifact
```

The syscall layer validates capabilities and writes CRDs/events.

## Reconciliation Example

```text
Agent/wren desiredState=active
  -> AgentController creates BrainBinding
  -> BrainController creates Pod/brain-wren
  -> brain emits brain.woke
  -> projection updates AgentTree
```

## Sleeping and Waking

Agents can be addressable without live brains.

```text
message arrives for sleeping agent
  -> append message.received
  -> create BrainBinding
  -> brain wakes from session log
```

## Garbage Collection

Never silently remove:

```text
raw event logs
retained artifacts
homes
workspaces with unmerged changes
audit records
pending approvals
```

TTL candidates:

```text
idle brain pods
idle hands pods
ephemeral workspaces after successful artifact extraction
old projections
completed runs after retention snapshot
```

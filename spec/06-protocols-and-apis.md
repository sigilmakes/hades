# 06 — Protocols and APIs

Hades exposes two layers:

1. **ACP-compatible agent API** for agent interoperability.
2. **Hades management API** for operating the cluster, sessions, hands, workspaces, approvals, and UI.

ACP is the public agent communication protocol. Hades APIs extend it with control-plane operations.

## ACP Endpoints

Hades should implement these ACP endpoints:

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

### GET /agents

Returns discoverable Hades AgentClasses and possibly live AgentSessions.

Example response:

```json
{
  "agents": [
    {
      "name": "planner",
      "description": "Plans implementation strategy and decomposes work.",
      "input_content_types": ["text/plain", "application/json"],
      "output_content_types": ["text/plain", "text/markdown", "application/json"],
      "metadata": {
        "hades.kind": "AgentClass",
        "hades.requires_hands": false,
        "hades.default_model": "anthropic/claude-sonnet-4-6"
      }
    }
  ]
}
```

### POST /runs

Creates an AgentRun.

```json
{
  "agent_name": "planner",
  "session_id": "9b2967e7-4a16-4c50-8e5d-51516e01b29b",
  "input": [
    {
      "role": "user",
      "parts": [
        {
          "content_type": "text/plain",
          "content": "Design the auth refresh fix."
        }
      ]
    }
  ],
  "mode": "stream"
}
```

Hades maps this to:

```text
AgentRun CRD
session/event log entries
possible AgentSession creation/wake
brain pod creation if needed
```

### GET /runs/{run_id}/events

Returns ACP events:

```text
message.created
message.part
message.completed
run.created
run.in-progress
run.awaiting
run.completed
run.failed
run.cancelled
error
```

Hades may include `generic` events for Hades-specific observability, but must not require ACP clients to understand them.

## Hades Management API

Base path examples use `/hades/v1`.

### Cluster and Dashboard

```text
GET /hades/v1/dashboard
GET /hades/v1/events/stream
GET /hades/v1/metrics/summary
```

`GET /dashboard` returns a projection suitable for TUI/Web:

```json
{
  "cluster": "local-k3s",
  "namespace": "project-auth",
  "runs": [...],
  "agents": [...],
  "tasks": [...],
  "approvals": [...],
  "activity": [...],
  "stats": {...}
}
```

### Agents

```text
GET  /hades/v1/agents
GET  /hades/v1/agents/{agent_ref}
POST /hades/v1/agents
POST /hades/v1/agents/{agent_ref}/message
POST /hades/v1/agents/{agent_ref}/wake
POST /hades/v1/agents/{agent_ref}/sleep
POST /hades/v1/agents/{agent_ref}/cancel
DELETE /hades/v1/agents/{agent_ref}
```

Direct message:

```json
{
  "message": {
    "role": "user",
    "parts": [
      {
        "content_type": "text/plain",
        "content": "Pause before editing. Explain the proposed files first."
      }
    ]
  }
}
```

### Hands

```text
GET  /hades/v1/hands
GET  /hades/v1/hands/{hands_ref}
POST /hades/v1/hands
POST /hades/v1/hands/{hands_ref}/execute
GET  /hades/v1/hands/{hands_ref}/stream
POST /hades/v1/hands/{hands_ref}/attach
POST /hades/v1/hands/{hands_ref}/restart
DELETE /hades/v1/hands/{hands_ref}
```

Execute:

```json
{
  "tool": "bash",
  "input": {
    "command": "npm test -- auth",
    "timeout_seconds": 120
  },
  "caller": "agent/coder-auth-001"
}
```

Result:

```json
{
  "ok": false,
  "exit_code": 1,
  "stdout_ref": "artifact/tool-stdout-123",
  "stderr_ref": "artifact/tool-stderr-123",
  "summary": "2 tests failed in AuthRefresh.test.ts"
}
```

### Workspaces

```text
GET  /hades/v1/workspaces
POST /hades/v1/workspaces
GET  /hades/v1/workspaces/{workspace_ref}
POST /hades/v1/workspaces/{workspace_ref}/snapshot
POST /hades/v1/workspaces/{workspace_ref}/diff
POST /hades/v1/workspaces/{workspace_ref}/merge-proposal
DELETE /hades/v1/workspaces/{workspace_ref}
```

### Approvals

```text
GET  /hades/v1/approvals
GET  /hades/v1/approvals/{approval_ref}
POST /hades/v1/approvals/{approval_ref}/respond
```

Approval response:

```json
{
  "decision": "approve-with-constraints",
  "message": {
    "role": "user",
    "parts": [
      {
        "content_type": "text/plain",
        "content": "Approved. Keep backward compatibility and add tests."
      }
    ]
  }
}
```

### Tasks

Tasks are dashboard/control-plane objects, not necessarily ACP runs.

```text
GET  /hades/v1/tasks
POST /hades/v1/tasks
GET  /hades/v1/tasks/{task_ref}
POST /hades/v1/tasks/{task_ref}/assign
POST /hades/v1/tasks/{task_ref}/block
POST /hades/v1/tasks/{task_ref}/complete
```

### Artifacts

```text
GET  /hades/v1/artifacts
GET  /hades/v1/artifacts/{artifact_ref}
POST /hades/v1/artifacts
```

## Addressing

Hades refs should be stable and human-readable where possible.

```text
cluster/local/ns/project-auth/agent/planner-auth-001
cluster/local/ns/project-auth/run/run-plan-auth-flow
cluster/local/ns/project-auth/hands/repo-auth-readonly
cluster/local/ns/project-auth/workspace/wt-auth-coder-001
cluster/local/ns/project-auth/approval/approval-17
```

Short forms allowed in namespace context:

```text
agent/planner-auth-001
run/run-plan-auth-flow
hands/repo-auth-readonly
```

URI form:

```text
hades://local/project-auth/agent/planner-auth-001
```

## Event Taxonomy

### Session Events

```text
session.created
session.loaded
session.checkpointed
session.compacted
session.archived
```

### Agent Events

```text
agent.created
agent.waking
agent.active
agent.message.received
agent.message.sent
agent.awaiting
agent.sleeping
agent.completed
agent.failed
agent.cancelled
```

### Brain Events

```text
brain.pod.requested
brain.pod.started
brain.woke
brain.model.started
brain.model.token
brain.model.completed
brain.context.selected
brain.sleeping
brain.crashed
brain.replaced
```

### Hands Events

```text
hands.requested
hands.provisioning
hands.ready
hands.attached
hands.detached
hands.degraded
hands.replaced
hands.terminated
```

### Tool Events

```text
tool.requested
tool.started
tool.stdout
tool.stderr
tool.completed
tool.failed
tool.cancelled
```

### Approval Events

```text
approval.requested
approval.updated
approval.responded
approval.expired
approval.cancelled
```

### Workspace Events

```text
workspace.requested
workspace.ready
workspace.diff.created
workspace.patch.created
workspace.merge.proposed
workspace.merged
workspace.conflicted
```

## Streaming

Hades should support SSE and WebSocket.

SSE for simple consumers:

```text
GET /hades/v1/events/stream?namespace=project-auth&run=run-123
```

WebSocket for TUI/Web:

```text
WS /hades/v1/ws
```

Client messages:

```json
{ "type": "subscribe", "filter": { "namespace": "project-auth" } }
{ "type": "message.agent", "agent_ref": "agent/planner", "message": {...} }
{ "type": "approval.respond", "approval_ref": "approval-17", "decision": "approve" }
```

Server messages:

```json
{ "type": "event", "event": {...} }
{ "type": "projection", "dashboard": {...} }
{ "type": "error", "error": {...} }
```

## Compatibility Boundaries

ACP clients should be able to:

```text
- discover Hades agents
- start runs
- stream run events
- resume awaiting runs
- cancel runs
```

Hades clients can additionally:

```text
- directly message live/sleeping agents
- attach to hands pods
- inspect workspaces
- control approvals
- watch dashboard projections
- operate Kubernetes-backed resources
```

## API Design Principle

Every UI action should map to a stable API call.

If the TUI can do it, the CLI and web UI should be able to do it too.

```text
TUI keypress
    -> Hades API request
        -> event appended
            -> projection updated
                -> all clients see same state
```

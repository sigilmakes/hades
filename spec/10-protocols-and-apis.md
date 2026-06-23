# 10 — Protocols and APIs

Hades exposes three API layers:

1. Agent wire protocol compatibility (ACP first, A2A bridge if needed).
2. Hades management APIs for humans/apps/CI.
3. AgentOS syscalls for agents.

## Compatibility Stance

ACP is the initial public agent protocol because it matches the desired run/session model. A2A is common in existing Kubernetes agent platforms and should be bridged where useful.

The invariant is not the acronym. The invariant is:

```text
agents are addressable
runs are streamable
await/resume/cancel are explicit
messages are durable events
```

## ACP-Compatible Endpoints

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

## Hades Management API

```text
GET  /hades/v1/dashboard
GET  /hades/v1/events/stream
GET  /hades/v1/agents
POST /hades/v1/agents
POST /hades/v1/agents/{agent}/message
POST /hades/v1/agents/{agent}/wake
POST /hades/v1/agents/{agent}/sleep
GET  /hades/v1/homes
GET  /hades/v1/listeners
GET  /hades/v1/schedules
GET  /hades/v1/hands
POST /hades/v1/hands/{hands}/execute
GET  /hades/v1/approvals
POST /hades/v1/approvals/{approval}/respond
```

## AgentOS Syscalls

These are exposed as pi SDK tools to brains, backed by the Hades API.

```text
os.createSchedule(spec)
os.updateSchedule(ref, patch)
os.deleteSchedule(ref)
os.writeHomeFile(path, content)
os.createTool(path, content)
os.spawnAgent(classRef, input, constraints)
os.messageAgent(agentRef, message)
os.attachListener(spec)
os.createHands(spec)
os.emitArtifact(spec)
os.requestApproval(prompt, options)
```

## Addressing

```text
hades://local/agent-wren/agent/wren
hades://local/agent-wren/session/default
hades://local/agent-wren/listener/wren-discord
hades://local/agent-wren/hands/wren-home-shell
hades://local/agent-wren/schedule/recess
```

Short forms work in namespace context:

```text
agent/wren
session/default
listener/wren-discord
hands/wren-home-shell
```

## Event Taxonomy

```text
session.created
session.loaded
session.checkpointed

agent.created
agent.waking
agent.active
agent.awaiting
agent.sleeping
agent.failed

brain.pod.requested
brain.woke
brain.model.started
brain.model.token
brain.model.completed
brain.crashed
brain.replaced

listener.connected
listener.message.received
listener.delivered
listener.failed

schedule.created
schedule.fired
schedule.skipped
schedule.updated

hands.requested
hands.ready
hands.degraded
hands.terminated

tool.requested
tool.stdout
tool.stderr
tool.completed
tool.failed

approval.requested
approval.responded
approval.expired

home.file.written
home.tool.created
artifact.created
capability.denied
```

## Streaming

SSE for simple readers:

```text
GET /hades/v1/events/stream?agent=wren
```

WebSocket for TUI/web:

```text
WS /hades/v1/ws
```

## API Design Principle

Every UI action maps to an API call.

```text
TUI keypress -> Hades API -> event appended -> projections updated -> all clients see it
```

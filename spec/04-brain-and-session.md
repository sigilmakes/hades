# 04 — Brain and Session

The brain is the model/harness loop. The session is the durable event log. They are separate.

## Brain Pod

A brain pod embeds the pi SDK directly.

```text
Brain Pod
  ├─ pi SDK AgentSession / AgentSessionRuntime
  ├─ model registry and auth storage
  ├─ context selector
  ├─ Hades tool adapters
  ├─ event emitter
  └─ ACP/A2A/Hades protocol adapter
```

It does **not** contain:

```text
raw tool sandbox
repo checkout by default
generated-code runtime
agent home credentials
session durability
```

## Why SDK, Not RPC

Old model:

```text
nest daemon -> spawn pi --mode rpc inside container -> same home/sandbox/creds
```

New model:

```text
brain pod -> createAgentSession(...) in process
brain tools -> Hades execute() -> hands pod
```

SDK advantages:

```text
type-safe session control
direct model switching
direct compaction
direct event subscription
direct runtime replacement
no stdin/stdout protocol glue
no brain hidden inside sandbox
```

## Wake Flow

```text
message/schedule/run arrives
        │
        v
RunController ensures Agent active
        │
        v
Brain pod starts with HADES_SESSION_ID
        │
        v
brain calls getEvents(session)
        │
        v
context selector builds model context
        │
        v
pi SDK session.prompt(...)
```

## Sleep Flow

```text
idle timeout / explicit sleep
        │
        v
brain waits for model/tool idle
        │
        v
emit brain.sleeping(checkpoint=eventId)
        │
        v
pod exits
        │
        v
Agent remains addressable with no brain pod
```

## Session Log

The session log is append-only and queryable.

```json
{
  "id": "evt_000128",
  "session_id": "sess_wren_default",
  "agent_ref": "agent/wren",
  "type": "tool.completed",
  "created_at": "2026-06-23T13:00:00Z",
  "payload": {
    "tool": "bash",
    "ok": true,
    "summary": "wrote cron.d/recess.md"
  },
  "causality": {
    "trace_id": "trace_recess_edit",
    "parent_event_id": "evt_000127"
  }
}
```

## Context Is Not the Log

The model context window is a projection.

Brain asks:

```text
getEvents(session, last=80)
getEvents(session, around=evt_50, before=20, after=10)
getEvents(session, filter={type: tool.completed})
getMemory(agent, query="Willow preferences")
```

Then the context selector chooses what enters the model.

This lets future models change context strategy without migrating durable history.

## Brain Failure

```text
brain pod crashes
   │
   v
controller sees desiredState=active
   │
   v
new brain pod starts
   │
   v
wake(sessionId)
   │
   v
read event log and resume
```

Failure of a brain is not failure of the agent.

## Model Configuration

Model config lives in brain runtime configuration, not inside hands.

```text
AuthStorage: kernel/brain secret context
ModelRegistry: settings + models.json + provider config
Hands: no model credentials
```

Ollama cloud is a model provider entry; the Hades kernel does not special-case it.

# 06 — Listeners and I/O

Listeners are per-agent I/O devices: Discord, Matrix, email, web chat, CLI, TUI, voice, webhooks.

They are not tools.

```text
Listener = terminal/network device/mailbox
Tool     = action capability/syscall
```

## Per-Agent Listeners

Agent A can have Discord and Matrix:

```text
Agent/wren
  ├─ Listener/wren-discord
  └─ Listener/wren-matrix
```

Agent B can have email and separate Discord:

```text
Agent/muse
  ├─ Listener/muse-email
  └─ Listener/muse-discord
```

## Listener Resource

```yaml
kind: Listener
metadata:
  name: wren-discord
spec:
  agentRef: wren
  platform: discord
  secretRef: wren-discord-token
  routes:
    - external: "1333841182794580112"
      session: default
  allowedUsers:
    - sigil__
    - mankymeson
```

## Inbound Event Shape

```json
{
  "type": "listener.message.received",
  "listener_ref": "listener/wren-discord",
  "agent_ref": "agent/wren",
  "session_ref": "session/default",
  "origin": {
    "platform": "discord",
    "channel": "1333841182794580112",
    "sender": "sigil__",
    "thread": null
  },
  "message": {
    "content_type": "text/plain",
    "content": "good morning bird"
  }
}
```

## Default Reply Routing

Replies default to the inbound origin:

```text
Discord message -> wren/default -> brain response -> same Discord channel/thread
```

The origin is stored in the event log so brain restarts do not lose the routing path.

## Notify Routing

Schedules and system events have no inbound origin, so they declare notify targets:

```yaml
notify:
  - listenerRef: wren-discord
    target: "1333841182794580112"
```

## Fan-In

Multiple listeners can feed one session:

```text
Discord ─┐
Matrix  ─┼──> Session/wren-default
Web     ─┘
```

## Fan-Out

One event can be broadcast to configured listeners:

```text
schedule fired -> Discord notify + Matrix notify
```

Policy decides whether fan-out is allowed.

## Listener Pods

Listener pods are cattle.

```text
Listener CRD -> ListenerController -> Pod/listener-discord-* -> events into Hades API
```

If the listener crashes, the agent and session persist.

## Direct Agent Chat

The Hades API can bypass external bridges:

```text
POST /hades/v1/agents/{agent}/message
```

This is equivalent to a kernel console attached to the agent.

## Attachments and Files

Listeners may receive files and emit artifacts.

```text
Discord attachment -> Artifact -> optional Home inbox path -> brain sees event
Brain attach(file) -> Artifact -> listener sends file
```

The old nest `attach` tool becomes an OS/listener operation, not an HTTP upload to itself.

# 04 — Brain / Hands Architecture

Hades adopts the managed-agents separation:

```text
session log = durable memory and event stream
brain       = reasoning harness and model loop
hands       = tool/sandbox execution environment
```

## The Split

```text
                         ┌──────────────────────┐
                         │ Session/Event Store  │
                         │ durable, queryable   │
                         └──────────┬───────────┘
                                    │
                                    │ getEvents / emitEvent
                                    v
┌──────────────────────────────────────────────────────────────────────┐
│ Brain Pod                                                             │
│                                                                      │
│  - pi SDK session/harness                                             │
│  - model/provider client                                              │
│  - context selection                                                  │
│  - tool routing                                                       │
│  - ACP client/server adapter                                          │
│  - Hades event emitter                                                │
│                                                                      │
│  Does NOT contain: repo checkout, raw OAuth secrets, generated-code    │
│  runtime, durable truth.                                              │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ execute(tool, input)
                                v
┌──────────────────────────────────────────────────────────────────────┐
│ Hands Pod                                                             │
│                                                                      │
│  - shell                                                              │
│  - repo/worktree                                                      │
│  - language runtimes                                                  │
│  - tests/build tools                                                  │
│  - browser automation                                                 │
│  - MCP servers/proxies                                                │
│  - terminal/PTY                                                       │
│                                                                      │
│  Disposable, replaceable, shareable according to policy.              │
└──────────────────────────────────────────────────────────────────────┘
```

## Brain Pod Responsibilities

A brain pod is a stateless or near-stateless process that can be killed and restarted.

Responsibilities:

```text
- wake from a session id
- read session events
- choose context slices for the model
- run pi SDK model sessions
- receive model tool requests
- route tool requests to hands pods
- receive tool results/errors
- emit every meaningful event to Hades
- enter awaiting/sleeping/completed states
```

Brain pod startup:

```text
1. receives HADES_SESSION_ID
2. connects to Hades API
3. calls getSession(sessionId)
4. reads relevant event slices
5. reconstructs harness state
6. starts/resumes pi SDK session
7. emits brain.woke
```

Brain pod shutdown:

```text
1. drains in-flight model/tool events if possible
2. emits brain.sleeping or brain.terminated
3. exits cleanly
```

A crash is acceptable because the event store is authoritative.

## Hands Pod Responsibilities

A hands pod is an execution environment.

Responsibilities:

```text
- expose tool endpoints to brains
- execute commands with resource limits
- stream stdout/stderr/tool events
- maintain workspace filesystem state while alive
- persist artifacts/patches/logs as configured
- enforce local sandbox policies
```

Hands pod types:

```text
repo-toolbox      shell, git, rg, language runtimes, tests
browser           browser automation / web UI inspection
mcp-proxy         local MCP server or proxy endpoint
python-lab        notebook / Python scientific tools
gpu-worker        CUDA/ROCm workloads
phone-emulator    mobile testing
custom            user-defined image
```

## Many Brains, Many Hands

```text
                  ┌───────────────────────┐
                  │ Hands: repo-readonly  │
                  │ rg/read/git/test-ro   │
                  └───────┬───────┬───────┘
                          │       │
        ┌─────────────────┘       └─────────────────┐
        v                                           v
┌────────────────┐                         ┌────────────────┐
│ Brain: planner │                         │ Brain: explorer│
└────────────────┘                         └────────────────┘
        │                                           │
        └─────────────────┐       ┌─────────────────┘
                          v       v
                    ┌────────────────┐
                    │ Brain: review  │
                    └────────────────┘
```

One brain can also hold multiple hands:

```text
┌────────────────┐
│ Brain: coder   │
└───────┬────────┘
        │
        ├──────────────> Hands: repo-worktree
        ├──────────────> Hands: browser-preview
        └──────────────> Hands: docs-search-mcp
```

## Sharing Policy

Hands sharing should be explicit and policy-driven.

```text
shared-readonly:
    multiple agents can read and run safe commands

exclusive-writable:
    one writer agent owns a worktree

shared-cache:
    multiple agents share package/build cache but not workspace writes

exclusive-sensitive:
    one agent/session can use sensitive tool pod
```

Table:

| Hands Mode | Readers | Writers | Typical Use |
|---|---:|---:|---|
| `shared-readonly` | many | none | scouts, reviewers, grep, read-only tests |
| `exclusive-worktree` | one/many | one | coding agents |
| `ephemeral-command` | one | maybe | dangerous shell/test run |
| `shared-service` | many | service-defined | browser, MCP proxy, DB sandbox |
| `sensitive-exclusive` | one | one | credentials, customer data, production-like env |

## Tool Call Flow

```text
Brain Pod                         Hades API                     Hands Pod
   │                                  │                             │
   │ tool.requested event             │                             │
   ├─────────────────────────────────>│                             │
   │                                  │ execute request             │
   │                                  ├────────────────────────────>│
   │                                  │                             │ run command
   │                                  │ tool.stdout/stderr events   │
   │                                  │<────────────────────────────┤
   │ stream to brain                  │                             │
   │<─────────────────────────────────┤                             │
   │                                  │ tool.completed event        │
   │                                  │<────────────────────────────┤
   │ tool result                      │                             │
   │<─────────────────────────────────┤                             │
```

The brain sees a normal tool result or tool error. It does not know whether the hands pod was a container, a remote VM, a browser, a phone, or a service.

## Failure Handling

### Hands Pod Failure

```text
Brain calls execute("npm test")
       │
       v
Hands pod crashes
       │
       v
Hades emits tool.failed + hands.degraded
       │
       v
Brain receives tool error
       │
       ├─ retry after Hades provisions replacement
       ├─ ask human
       ├─ switch hands
       └─ fail gracefully
```

ASCII:

```text
┌──────────────┐      execute       ┌──────────────┐
│ Brain coder  │ ─────────────────> │ Hands repo   │
└──────┬───────┘                    └──────┬───────┘
       │                                   │
       │                                   X crash
       │                                   │
       │      tool_error                   │
       │ <─────────────────────────────────┘
       │
       v
 emitEvent(tool.failed)
       │
       v
 Hades may provision new hands pod
```

### Brain Pod Failure

```text
Brain pod crashes
       │
       v
Kubernetes marks pod failed
       │
       v
Hades controller sees AgentSession desiredState=active
       │
       v
New brain pod starts
       │
       v
wake(sessionId)
       │
       v
getEvents()
       │
       v
resume
```

ASCII:

```text
┌──────────────┐
│ Brain old    │
└──────┬───────┘
       X
       │
       v
┌──────────────┐       creates       ┌──────────────┐
│ Controller   │ ──────────────────> │ Brain new    │
└──────┬───────┘                     └──────┬───────┘
       │                                    │
       │                                    v
       │                            wake(sessionId)
       │                                    │
       v                                    v
┌────────────────────────────────────────────────────┐
│ Session/Event Store                                 │
└────────────────────────────────────────────────────┘
```

### Event Store Failure

The event store is the most critical component. It must be highly available before production.

Prototype:

```text
SQLite/Postgres in PVC acceptable for local k3s.
```

Production:

```text
managed Postgres or HA Postgres
object store for artifacts/session payloads
backups and point-in-time recovery
```

## Time-to-First-Token

Brain/hands split improves responsiveness.

Bad:

```text
create full sandbox
clone repo
install deps
start harness
then model starts
```

Good:

```text
start brain
model starts
provision hands only when needed
```

Many tasks do not need a repo shell immediately. Some may only need planning, discussion, routing, or ACP communication.

## Context Is Not the Model Window

The session log is a queryable object outside the model context window.

Brain can ask:

```text
getEvents(sessionId, last=50)
getEvents(sessionId, around=eventId, before=20, after=10)
getEvents(sessionId, filter={type: "tool.completed", agent: "coder"})
getEvents(sessionId, range=[100, 150])
```

The harness decides what to put into the pi SDK/model context. The underlying session log remains complete.

## Brain Tool Surface

The brain sees tools like:

```text
execute(hand, tool, input)
message(agent, content)
await_human(prompt, options)
spawn_agent(class, input)
attach_hand(spec)
create_workspace(spec)
emit_artifact(name, contentType, content)
complete(result)
```

But these tools are not hidden orchestration. Every call maps to Hades events and resources.

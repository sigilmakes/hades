# 02 — AgentOS Ontology

Hades uses OS vocabulary deliberately. The goal is a small set of primitives that scale from one Wren on one node to many agents across a cluster.

## Object Model

```text
Agent       process / user identity
Brain       live model+harness loop for an agent
Session     durable event log and conversational state
Home        persistent user filesystem
Hands       execution/sandbox environment
Tool        callable capability exposed to a brain
Listener    attached I/O device or bridge
Schedule    timer that injects prompts or syscalls
Capability  permission to perform OS operations
Run         bounded unit of work in a session
Approval    resumable human/policy gate
Artifact    durable output reference
SystemAgent privileged userland process
```

## Core Separation

```text
Agent identity  != Brain pod
Brain pod       != Hands pod
Home filesystem != Session log
Listener        != Tool
Schedule        != Agent
Capability      != Kubernetes RBAC alone
```

These distinctions prevent old nest-style collapse.

## Agent

An Agent is a durable identity and policy domain. It may be a resident like Wren, a finite subagent, or a system process.

```yaml
kind: Agent
spec:
  displayName: Wren
  classRef: resident-pi
  homeRef: wren-home
  defaultSession: default
  desiredState: active
  modelPolicy:
    default: ollama-cloud/qwen
```

An agent may have zero or more brain pods over time.

## Brain

A Brain is a live pod running a pi SDK session. It wakes from session events, calls models, routes tool calls, then sleeps or exits.

```text
brain pod = cattle
session log = durable truth
```

## Session

A Session is the append-only record of what happened. It is not the model context window.

```text
message.received
brain.woke
model.started
model.token
tool.requested
tool.completed
approval.requested
schedule.fired
listener.delivered
```

## Home

A Home is an agent's persistent userland filesystem.

For Wren:

```text
/home/wren
  vault/
  bin/
  cron.d/
  projects/
  skills/
  sketches/
  config/
```

The home is mutable. Agents may edit it through approved tools. Kernel credentials are not stored here.

## Hands

Hands are execution environments. They may mount some or all of a Home, Workspace, cache, browser profile, or tool set.

```text
repo-toolbox
browser
mcp-proxy
python-lab
email-draft-sandbox
minecraft-client
```

Hands have no raw model credentials.

## Listener

A Listener is an I/O device attached to an agent: Discord, Matrix, email, webhook, web chat, CLI, TUI, voice.

Listeners are per-agent and route messages into sessions.

## Schedule

A Schedule is cron/systemd-timer for agents. It can prompt an agent, call an OS syscall, or wake a system agent.

Schedules are userland resources. Agent-authored schedules are part of autonomy.

## Capability

Capabilities are typed permissions above raw Kubernetes RBAC.

Examples:

```text
createSchedule
updateOwnHome
spawnChildAgent
attachListener
readSessionContent
rotateSecret
createHands
approveTool
```

Capabilities can be granted to humans, agents, or system agents.

## System Agent

A SystemAgent is an ordinary agent with elevated scoped capabilities, such as provisioner, janitor, auditor, backup, or librarian.

It is not kernel code. It is privileged userland.

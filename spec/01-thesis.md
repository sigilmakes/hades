# 01 — Thesis

## The Problem

Most agent orchestration systems hide multiple agents behind one outer tool call:

```text
main agent
  |
  | tool: run_workflow(...)
  v
hidden harness
  ├─ hidden subagent A
  ├─ hidden subagent B
  └─ hidden subagent C
  |
  v
single returned blob
```

That is the wrong abstraction for long-running work. Agents become invisible implementation details. Humans cannot talk to a subagent. Failures collapse into one tool error. The dashboard becomes a post-hoc renderer rather than a live operating surface.

Hades starts from the opposite premise:

> Agents are managed compute units in a distributed operating system.

## Product Thesis

Hades is a Kubernetes-native agent operating system. It provides a minimal kernel for running agents with durable state, scoped capabilities, and observable lifecycles.

It must support:

- long-lived resident agents like Wren
- ephemeral coding/research/review subagents
- direct human-to-agent and agent-to-agent communication
- per-agent listeners such as Discord, Matrix, email, web, and CLI
- agent-authored schedules and tools
- durable session/event logs
- pi SDK brain execution
- disposable hands/tool pods
- policy-checked self-modification
- system agents that manage the cluster itself

## Why Old Nest Failed

The old Wren harness bundled too much into one pet container:

```text
one container
  ├─ pi RPC brain
  ├─ tool sandbox
  ├─ vault
  ├─ cron jobs
  ├─ SSH keys and model auth
  ├─ Discord bridge
  ├─ dashboard
  ├─ HTTP API
  └─ generated code execution
```

The wrong part was **not** Wren editing her crons or building tools. That was userland working correctly.

The wrong part was putting the kernel, brain, hands, credentials, home, dashboard, and deployment generator in one environment.

## Design Center

Hades makes the OS boundary explicit:

```text
kernel:    small control plane, controllers, APIs, policy, durable logs
userland:  agent homes, crons, vaults, tools, projects, skills
hands:     disposable execution pods
listeners: attached devices and bridges
brains:    model/harness loops via pi SDK
```

## Core Rejection

Tool calls are good for narrow capability boundaries:

```text
read file
run command
query API
send message
create schedule
```

Tool calls are bad as the primary representation for an agent society.

A society needs:

```text
identity
addressing
lifecycles
logs
homes
permissions
schedules
listeners
topology
supervision
```

That is Hades.

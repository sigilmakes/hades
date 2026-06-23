# 01 — Thesis

## The Problem

Current agent orchestration systems commonly hide multi-agent work inside a single model tool call. The visible system sees something like:

```text
main agent
    |
    | tool call: run_workflow(script)
    v
workflow sandbox
    |
    +-- hidden subagent A
    +-- hidden subagent B
    +-- hidden subagent C
    |
    v
single returned blob
```

This is the wrong abstraction for serious agentic work.

It makes agents look like tool internals rather than independent, inspectable, restartable compute. It prevents humans from directly talking to subagents. It compresses many execution states into one outer tool state. It encourages cosmetic dashboards that render summaries after the fact rather than operating a live distributed system.

Hades starts from the opposite premise:

> Agents are managed compute units in a distributed operating system.

The orchestrator is not an agent tool. The orchestrator is a control plane.

## Product Thesis

Hades is a Kubernetes-native agent operating system for long-running, multi-agent work.

It provides:

- durable sessions and event logs
- ACP-compatible agent communication
- Kubernetes-native lifecycle management
- pi SDK powered brain pods
- disposable hands/tool pods
- direct human-to-agent communication
- observable task graphs and activity streams
- approval/resume/cancel primitives
- workspace and artifact management
- security boundaries for credentials and untrusted code

## Non-Negotiable Requirements

### Kubernetes From Day One

No local-only architecture that later grows Kubernetes bolted to the side. The smallest deployment can be k3s or kind, but it must still use Kubernetes concepts: pods, services, namespaces, jobs, persistent volumes, CRDs, controllers, RBAC, and network policy.

### Direct Addressability

Every meaningful agent must have an address.

```text
hades://cluster/local/ns/project-auth/agent/planner
hades://cluster/local/ns/project-auth/hands/repo-auth
hades://cluster/local/ns/project-auth/run/auth-redesign
```

If a human selects `planner`, the human can message `planner` directly. If a human selects a hands pod, the human can attach to its terminal or inspect its tool history. No hidden subagents.

### Brains and Hands Are Separate

A brain is the model/harness loop. A hand is an execution/tool environment.

```text
Brain:
    thinks, plans, calls tools, emits events

Hands:
    run shell commands, edit files, execute tests, use browsers, host MCP tools
```

The harness must not live inside the same container as generated code and tool execution. This follows Anthropic's managed-agents lesson: decouple the brain from the hands so each can fail and be replaced independently.

### Durable Session/Event Log

The durable truth is not the model context window, not the brain pod filesystem, and not the hands pod filesystem.

The durable truth is the event/session log.

```text
session.created
agent.spawned
brain.woke
message.created
message.part
tool.requested
tool.completed
approval.requested
run.awaiting
run.resumed
artifact.created
run.completed
```

Everything else is a cache or a live projection.

### Programmatic Workflows Are Clients

Agents may write scripts. Humans may write scripts. CI may run scripts. But workflow scripts are clients of Hades, not the substrate.

```text
workflow.js
    |
    | calls ACP/Hades APIs
    v
Hades control plane
    |
    +-- creates agents
    +-- routes messages
    +-- observes events
    +-- manages pods
```

This preserves the power of scripting without hiding the system behind a single tool invocation.

## What Hades Is Not

Hades is not:

- a pi extension
- a single tool call
- a pretty workflow result renderer
- a tmux-only channel bus
- a LangChain-like in-process graph runner
- a replacement for MCP
- a replacement for Kubernetes
- a bespoke agent framework that requires every agent to use one SDK

Hades is:

- a control plane
- an ACP-compatible agent fabric
- a Kubernetes-native runtime model
- a session/event operating system for agents

## Mental Model

```text
Kubernetes manages containers.
Hades manages agents.
```

But Hades should feel familiar to Kubernetes users:

```text
kubectl get agents
kubectl describe agent planner
kubectl logs agent/planner
kubectl exec hands/repo-auth -- bash
hades chat planner
hades approve approval-17
hades tui
```

## Design Center

Hades should optimize for long-horizon work where the user needs to:

- run many agents over hours or days
- recover from crashes
- inspect what happened
- intervene mid-flight
- talk to one subagent without confusing the rest
- isolate file modifications
- run untrusted code safely
- understand cost and resource use
- scale from laptop to cluster

## Core Rejection

This design rejects the idea that orchestration is best expressed as model tool calls.

Tool calls are good for crossing a narrow capability boundary:

```text
read file
run command
query API
invoke external service
```

They are bad as the primary representation for a distributed society of agents.

A society needs:

- identities
- addresses
- logs
- permissions
- lifecycle
- topology
- direct communication
- visibility
- scheduling
- supervision

That is Hades.

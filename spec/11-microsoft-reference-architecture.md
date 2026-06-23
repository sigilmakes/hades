# 11 — Microsoft Multi-Agent Reference Architecture

Source: <https://microsoft.github.io/multi-agent-reference-architecture/index.html>

This reference is not a deployable Kubernetes agent platform. It is a conceptual enterprise architecture for multi-agent systems. It is still useful because it validates several Hades requirements: central orchestration, agent registry, persistent storage, knowledge layer, MCP integration, observability, evaluation, security, and governance.

## High-Level Shape

The reference architecture looks like this:

```text
User
  │
  v
User Application
  │
  v
Orchestration Layer
  ├─ Orchestrator / Semantic Kernel
  ├─ Classifier / router
  └─ Agent Registry
       │
       ├─ Knowledge Layer
       │   ├─ source bases
       │   └─ vector DBs
       │
       ├─ Storage Layer
       │   ├─ conversation history
       │   ├─ agent state
       │   └─ registry storage
       │
       ├─ Agent Layer Local
       │   ├─ supervisor agent
       │   └─ specialized agents with MCP clients
       │
       ├─ Agent Layer Remote
       │   └─ remote specialized agents with MCP clients
       │
       ├─ Integration Layer / MCP Server
       │   └─ external tools
       │
       ├─ Observability
       └─ Evaluation
```

## What It Gets Right

### Central Registry

The reference strongly emphasizes an Agent Registry as the source of truth for:

```text
- agent identity
- description
- capabilities
- endpoint / communication mechanism
- authentication properties
- metadata and tags
- health and monitoring
- version information
```

It supports both registry-initiated discovery and agent self-registration.

This maps directly to Kubernetes-native platforms:

```text
Microsoft Agent Registry    → kagent Agent CRDs + DB
                            → KAOS Agent CRDs
                            → Ark Agents/A2AServers
                            → Hades AgentSession/AgentClass if greenfield
```

### Orchestration Layer

The orchestrator handles:

```text
- request/response lifecycle
- context preservation
- routing
- task decomposition
- fallback and recovery
- aggregation/synthesis
```

This is the right conceptual layer, but Hades should not make a single semantic kernel process the only authority. In Kubernetes terms, orchestration should be a control plane plus agent/controller loops.

### Classifier / Router

The reference recommends staged routing:

```text
cheap NLU/SLM classifier
    ↓ if uncertain
LLM classifier
    ↓ if no match
IDK / fallback
```

This is valuable for cost and reliability. In Hades/kagent terms, this could become:

```text
router agent / classifier service
    → Agent Registry query
    → selected Agent or Team
```

### Knowledge Layer

It separates knowledge bases and vector DBs from agent memory. Correct.

```text
Knowledge layer = governed domain data
Memory/storage = conversation and agent state
```

### Storage Layer

The reference calls out:

```text
- conversation history
- agent state
- registry storage
```

For the Hades/Managed Agents view, this becomes:

```text
- append-only session/event log
- queryable projections
- durable agent state snapshots
- registry records
```

### Observability + Evaluation

The reference correctly says observability is not enough. Evaluation analyzes observability data against success criteria.

Important evaluation targets:

```text
- orchestrator routing correctness
- plan efficiency
- final synthesis quality
- specialized agent task completion
- tool-call correctness
- registry discovery accuracy
- failure/error propagation
```

### Security/Governance

Important points:

```text
- agent identity enforcement
- RBAC for orchestration/execution
- mutual auth between agents
- scoped capabilities
- tool invocation policy
- encryption for storage and transport
- PII redaction and memory consent
- audit logs with caller identity + input/output hashes
- agent versioning and rollback
- manual override / pause agent class
```

These align with Kagenti/kagent/Kubernetes-native directions.

## What It Does Not Solve

The Microsoft architecture is deliberately conceptual and enterprise-agnostic. It does not answer the parts Willow cares about most:

```text
- Kubernetes CRD shape
- pod lifecycle
- brain/hands separation
- disposable tool pods
- Agent Sandbox integration
- direct UI control of a selected subagent
- concrete A2A/HITL implementation
- concrete coding-agent workspace model
- local k3s deployment path
```

It also recommends avoiding direct specialized-agent-to-specialized-agent messaging unless necessary, routing through the orchestrator for clarity. That is a reasonable enterprise default, but Hades needs a more flexible model:

```text
default: supervised routing through orchestrator/control plane
allowed: direct agent-to-agent communication when policy permits
required: human can directly message any selected agent
```

## Mapping to Candidate Platforms

| Microsoft Component | kagent | KAOS | Kelos | Orka | Ark | Kagenti | Agent Sandbox |
|---|---|---|---|---|---|---|---|
| User app | UI | UI | CLI/GitHub | UI/API | Dashboard | UI | n/a |
| Orchestrator | Controller + A2A + agents | Operator + agents | Task controller | Controller + AI worker | Controller + completions engine | platform middleware | n/a |
| Classifier | possible agent/tool | not obvious | task spawners/templates | chat/orchestrator tools | selector/team strategies | possible | n/a |
| Agent registry | Agent CRD + DB | Agent CRD | AgentConfig/Task | Agent CRD | Agent/A2AServer | agent cards/workloads | n/a |
| Knowledge | MCP/tools/memory | MCP/vector possible | workspace/context | memory/tools | memory/tools | MCP/tools | persistent sandbox files |
| Storage | SQLite/Postgres sessions/events | local/Redis memory | task status/logs | SQLite stores | etcd/Postgres | platform state | PVC/state |
| Agent comms | A2A | A2A | mostly task/pipeline | task/tools/messages | A2A | A2A | n/a |
| MCP/tools | ToolServers | MCPServer | MCP in AgentConfig | Tool CRDs/built-ins | Tool/MCP | MCP Gateway | hands substrate |
| Observability | OTel | OTel | kubectl/logs/status | metrics/logs/OTel | metrics/events | tracing/Kiali/Phoenix | k8s status |
| Evaluation | not central | not central | CI/task outputs | repository scans | docs/ops | governance focus | n/a |

## Impact on Recommendation

This reference makes the case for not chasing a totally bespoke architecture. The core shape is widely converging:

```text
registry + orchestrator + storage + MCP/tools + A2A/ACP + observability + eval
```

That is exactly where kagent, KAOS, Ark, Kagenti, and Orka are heading.

The differentiator for Willow's desired system is not the generic reference architecture. The differentiator is:

```text
1. direct operational UX for live agents
2. Anthropic-style brain/hands separation
3. Kubernetes Agent Sandbox as hands substrate
4. pi SDK/CLI brain/runtime integration
```

Those are better pursued as contributions/extensions to an existing strong Kubernetes agent platform, especially kagent, rather than by greenfielding the whole platform.

## Updated Recommendation

```text
Deploy kagent first.
Study KAOS UI/product design.
Deploy Agent Sandbox as the hands substrate.
Treat Microsoft reference architecture as the checklist.
Build/contribute the missing pieces upstream:
    - direct subagent room UX
    - sandbox-backed hands/tool pods
    - pi SDK / pi-compatible agent runtime
    - stronger event/evaluation projections
```

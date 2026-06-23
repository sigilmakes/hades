# 10 — Kubernetes Agent Platform Landscape

Research question:

> Should Hades be a new project, or should Willow deploy/contribute to an existing Kubernetes agent orchestration platform?

## Target Requirements

The desired system is not just "run an agent in Kubernetes". The target is an agent operating system:

```text
- Kubernetes-native from day one
- central control plane/API server
- agents are first-class addressable entities
- direct human-to-agent and agent-to-agent communication
- A2A/ACP-compatible protocol surface
- MCP/tool integration
- brain/hands separation inspired by Anthropic Managed Agents
- durable session/event log outside agent pods
- replaceable brain pods and replaceable hands/tool pods
- strong API first; frontend is a wrapper over API
- delightful KAOS-like web UX
- live nested subagent visibility and HITL
- secure credential handling
- local k3s/kind to cluster scale
```

## Candidates Reviewed

- KAOS — <https://github.com/axsaucedo/kaos>
- kagent — <https://github.com/kagent-dev/kagent>
- Kubernetes Agent Sandbox — <https://github.com/kubernetes-sigs/agent-sandbox>
- Kelos — <https://github.com/kelos-dev/kelos>
- Orka — <https://github.com/sozercan/orka>
- Ark — <https://github.com/mckinsey/agents-at-scale-ark>
- Kagenti — <https://github.com/kagenti/kagenti>

## Summary Recommendation

Do **not** greenfield Hades as a full competing platform yet.

The best near-term strategy is:

```text
Primary platform to evaluate/contribute to:  kagent
Hands substrate to adopt/contribute to:      Kubernetes Agent Sandbox
UI inspiration / lighter playground:         KAOS
Coding-agent workflow reference:             Kelos
Advanced security/governance reference:      Kagenti
Scale/API-server reference:                  Ark
Feature-rich coding/control-plane reference: Orka
```

If Willow wants one thing to deploy first, deploy **kagent**.

If Willow wants one additional substrate to deploy/learn next, deploy **agent-sandbox**.

KAOS looks good and is worth trying, but kagent is currently the stronger OSS foundation for the requested agent OS direction because it already has A2A subagents, nested HITL propagation, live subagent activity viewing, a web UI, CRDs, model configs, tool servers, and CNCF gravity.

## Ranking Against Willow's Target

| Rank | Project | Fit | Why |
|---:|---|---|---|
| 1 | kagent | Best general foundation | CNCF, active, A2A, nested subagents, HITL, UI, ModelConfig, MCP ToolServers, strong adoption. |
| 2 | Agent Sandbox | Best hands substrate | Kubernetes SIG project for stateful isolated singleton sandboxes; not an orchestrator, but ideal for hands/tool pods. |
| 3 | Kelos | Best coding-agent task runner | Very strong for autonomous coding agents, Git workspaces, TaskSpawners, PR workflows. Less conversational/control-room oriented. |
| 4 | Kagenti | Best zero-trust/governance reference | A2A/MCP, SPIFFE/SPIRE, Istio, OpenShift, security-first. Heavy. |
| 5 | Ark | Best enterprise declarative/API scale reference | Teams, Queries, A2A execution engines, aggregated API server/Postgres. Broad but less hands/control-room specific. |
| 6 | KAOS | Best lightweight/product-vibe reference | Nice UI/CLI, Agent/ModelAPI/MCPServer CRDs, A2A/MCP/OTel. Smaller and less mature. |
| 7 | Orka | Deep coding/control-plane reference | Very feature-rich, agent runtimes, tasks, agent-sandbox integration, but smaller adoption and more idiosyncratic. |

## kagent

Repo: <https://github.com/kagent-dev/kagent>

Observed metadata:

```text
stars: ~3063
forks: ~619
created: 2025-01-21
recently active: yes
CNCF project: yes
```

Core model:

```text
Agent CRD
ModelConfig CRD
RemoteMCPServer CRD
MCPServer via KMCP
Controller + HTTP server + DB
Agent pods running ADK runtime
Next.js UI
A2A proxy and server
```

Architecture:

```text
UI
 │ HTTP / A2A JSON-RPC
 v
kagent-controller
 ├─ controller manager
 ├─ HTTP server
 ├─ SQLite/Postgres DB
 └─ A2A proxy
      │
      v
Agent pod
 ├─ Python/Go ADK runtime
 ├─ A2A server
 ├─ MCP clients
 └─ session management
      │
      v
MCP ToolServers
```

Important strengths:

```text
- Mature adoption compared with other candidates.
- CNCF affiliation and community channels.
- Kubernetes-native CRDs.
- A2A is central, not an afterthought.
- Agents can use other agents as tools.
- Nested HITL propagation is implemented and documented.
- UI can show subagent activity live by polling subagent session IDs.
- HITL approval UI exists for tools requiring approval.
- ModelConfig covers Anthropic/OpenAI/Azure/Ollama/Gemini/Vertex/Bedrock.
- ToolServers/MCP are reusable across agents.
- Built-in AskUserTool and memory tools.
- Prompt templates, skills, context compaction.
- BYO agent mode exists.
```

Most important finding:

```text
kagent already solves part of the direct-subagent complaint.
```

It documents `KAgentRemoteA2ATool`, which adds:

```text
- HITL propagation from subagent to parent to user
- live activity viewing of subagent sessions
- user ID forwarding
```

This is close to the desired agent society model.

Gaps against Hades vision:

```text
- Brain/hands split is partial, not strict Anthropic Managed Agents style.
  Agent pod contains the ADK harness; tools are separate MCP servers, but the
  brain pod itself is still the agent runtime pod.

- Coding workspace/hands pod abstraction is not first-class in the same way as
  Agent Sandbox/Kelos/Orka. A repo shell/worktree hands pod would likely be an
  MCP server or custom ToolServer.

- Directly talking to any subagent likely works if it is also an Agent CRD, but
  subagent sessions are intentionally hidden from normal session history and
  surfaced as nested activity. UX may need improvement for "agent room" style
  direct steering.

- It uses A2A rather than ACP. Given ACP's migration/convergence into A2A under
  Linux Foundation, this is acceptable, but an ACP compatibility layer may still
  be desirable.

- It uses ADK as the default brain runtime. Pi SDK brain support would require
  BYO agent or new runtime integration.
```

Best contribution path:

```text
- Add a pi SDK / CLI-agent runtime adapter as BYO or declarative runtime.
- Add Agent Sandbox-backed ToolServer or workspace tool pod integration.
- Improve UI for direct subagent session drilldown and direct message-to-agent.
- Add ACP compatibility if still useful after ACP/A2A convergence.
- Add KAOS-style resource detail views if missing.
```

Verdict:

```text
Best platform to deploy first and contribute to.
```

## Kubernetes Agent Sandbox

Repo: <https://github.com/kubernetes-sigs/agent-sandbox>

Observed metadata:

```text
stars: ~2932
forks: ~349
Kubernetes SIG Apps project
recently active: yes
```

Core model:

```text
Sandbox CRD
SandboxTemplate
SandboxClaim
SandboxWarmPool
stable identity
persistent storage
pause/resume lifecycle
warm pools
```

What it is:

```text
A Kubernetes abstraction for isolated, stateful, singleton workloads.
```

What it is not:

```text
An agent orchestrator.
```

Why it matters:

This is the best match for the **hands pod** side of the Anthropic managed-agents architecture.

```text
Brain pod calls execute(tool, input)
      │
      v
Agent Sandbox / Hands environment
      │
      ├─ persistent workspace
      ├─ stable network identity
      ├─ strong isolation via runtime choice
      ├─ hibernation/resume roadmap
      └─ warm pools
```

Strengths:

```text
- Official Kubernetes SIG project.
- Designed exactly for AI agent runtimes and untrusted code sandboxes.
- Stable identity and persistent storage.
- Warm-pool model reduces startup latency.
- Strong isolation roadmap: gVisor/Kata/etc.
- Lifecycle primitives fit brain/hands separation.
```

Gaps:

```text
- No agent communication protocol.
- No model runtime.
- No dashboard for agent society.
- No A2A/ACP orchestration.
```

Verdict:

```text
Use as substrate, not as full platform.
```

## KAOS

Repo: <https://github.com/axsaucedo/kaos>

Observed metadata:

```text
stars: ~258
forks: ~17
created: 2025-12-28
single primary contributor
active
```

Core model:

```text
Agent CRD
ModelAPI CRD
MCPServer CRD
KAOS operator
KAOS UI
Pydantic AI Server runtime
A2A JSON-RPC
MCP tools
OpenTelemetry
```

Strengths:

```text
- Very approachable product shape.
- KAOS UI has the right visual/product vibe.
- Simple CRD model: Agent + ModelAPI + MCPServer.
- Good operator docs.
- UI includes agent list/detail/chat/memory/pods/YAML, MCP tool debug, model debug.
- `kaos ui` local proxy pattern avoids browser-stored kube credentials.
- OTel spans for agent loop/model/tool/delegation.
- A2A and MCP both present.
- Lightweight enough to understand and hack on.
```

Gaps:

```text
- Smaller ecosystem and adoption than kagent.
- A2A task manager appears mostly synchronous/in-memory in current docs.
- HITL/direct nested subagent control appears less advanced than kagent.
- Brain/hands split is not the Anthropic strict split; agent runtime pod is the harness.
- No first-class Agent Sandbox/workspace hands model found in docs.
- Distributed DAG execution is an open issue, not implemented.
- Security/identity target picture is newly opened, suggesting not settled.
```

Verdict:

```text
Best UI/product inspiration and good lightweight playground, but not the strongest base for the full target unless Willow wants to become a major upstream contributor/architect.
```

## Kelos

Repo: <https://github.com/kelos-dev/kelos>

Observed metadata:

```text
stars: ~222
forks: ~27
created: 2026-02-01
very active
large issue/PR volume, much of it self/agent-generated
```

Core model:

```text
Task
Workspace
AgentConfig
TaskSpawner
Kubernetes Jobs for autonomous coding agents
Claude Code / Codex / Gemini / OpenCode / Cursor image interface
```

Strengths:

```text
- Best-in-class for autonomous coding tasks on Kubernetes.
- Very detailed workspace/git credential/token-refresh model.
- TaskSpawner supports GitHub issues, PRs, webhooks, Linear, Jira, Slack, Cron.
- Agent image interface is concrete and practical.
- Captures outputs: branch, commit, PR, token usage, cost.
- Strong GitHub App/token freshness design.
- Supports pipelines via dependsOn and result passing.
- Excellent reference for coding agent images and PR workflows.
```

Gaps:

```text
- Task/job oriented, not live conversational agent OS.
- Harness and tools generally live in the same agent task pod, so it does not
  satisfy the strict managed-agents brain/hands split.
- Direct live steering of subagents is not the main model.
- Less about A2A agent society; more about Kubernetes Jobs for coding agents.
```

Verdict:

```text
If the actual goal is autonomous coding agents triggered by GitHub/Jira/etc., use Kelos.
If the goal is the Hades live agent OS, use Kelos as reference rather than base.
```

## Orka

Repo: <https://github.com/sozercan/orka>

Observed metadata:

```text
stars: ~7
forks: ~6
created: 2026-02-05
very active
```

Core model:

```text
Task
Agent
Tool
Provider
Skill
RepositoryScan
RepositoryMonitor
controller with REST/chat/UI
AI worker + general worker + CLI harness wrappers
```

Strengths:

```text
- Very feature-rich and close to coding-agent operations.
- Supports Codex, Claude Code, Copilot CLI runtimes.
- REST API, OpenAI-compatible API, Anthropic-compatible API.
- Embedded web UI.
- Task queue, priority, retries, session locking.
- Strong security notes: SA auth, OIDC, TxTokens, namespace isolation.
- Built-in coordination tools: delegate_task, wait_for_tasks, send_message,
  check_messages, create_agent_task, etc.
- Experimental upstream agent-sandbox integration already present.
- Repository scanning and repository monitor workflows.
```

Gaps:

```text
- Much smaller public adoption.
- Broad/idiosyncratic feature surface may be harder to align with.
- Agent Sandbox integration is experimental and not status-rich yet.
- Still primarily task/job/harness-wrapper oriented.
```

Verdict:

```text
Excellent reference. Potentially impressive. But risky as primary upstream due to small adoption.
```

## Ark

Repo: <https://github.com/mckinsey/agents-at-scale-ark>

Observed metadata:

```text
stars: ~398
forks: ~92
created: 2025-08-28
active
```

Core model:

```text
Agent
Model
Tool
Team
Query
Memory
ExecutionEngine
A2AServer
Dashboard
CLI/SDKs
```

Strengths:

```text
- Broad declarative agent platform.
- A2A support and A2A servers as external agents.
- Teams with strategies: sequential, graph, selector, round-robin.
- Query CRD is a clean user-request abstraction.
- Dashboard exists.
- Very strong scalability architecture: Kubernetes aggregation layer + Postgres
  backend, pg_notify watches, keyset pagination.
- Enterprise reference for API/storage scale.
```

Gaps:

```text
- Less focused on coding-agent workspaces/hands.
- More query/team declarative platform than live direct-agent control room.
- Current issue list includes production scalability/dashboard bugs, though this
  also indicates serious scale testing.
```

Verdict:

```text
Best reference for scalable API-server/storage design. Not the best direct match for Willow's live brain/hands agent OS.
```

## Kagenti

Repo: <https://github.com/kagenti/kagenti>

Observed metadata:

```text
stars: ~261
forks: ~95
created: 2025-03-27
active
OpenShift/Kind E2E badges
```

Core model:

```text
framework-neutral A2A/MCP platform
UI
identity/auth bridge
SPIFFE/SPIRE
Istio/Ambient/Gateway API
MCP Gateway
agent/tool lifecycle
Agent Sandbox support
```

Strengths:

```text
- Security and governance are central, not bolted on.
- A2A/MCP standards focus.
- Framework-neutral: LangGraph, CrewAI, Marvin, Autogen, etc.
- SPIFFE/SPIRE and service-mesh based identity patterns.
- UI for deploy/test/monitor agents/tools.
- Agent Sandbox support in local setup.
- OpenShift support.
```

Gaps:

```text
- Heavy stack for Willow's immediate local experimentation.
- More middleware/governance platform than simple delightful agent OS.
- Lots of moving parts: Istio, SPIRE, auth bridge, gateways.
```

Verdict:

```text
Best security/governance reference. Consider if zero-trust identity is the main axis. Otherwise use ideas rather than base.
```

## Key Decision

The landscape already has enough serious platforms that greenfielding Hades as a full agent OS is likely wasteful unless the point is research/learning.

The smart OSS strategy:

```text
Deploy kagent locally.
Deploy agent-sandbox locally.
Prototype the missing brain/hands bridge as contribution/extensions.
Use KAOS UI as taste reference.
Borrow Kelos workspace/coding-agent lessons.
Borrow Ark aggregated API/Postgres lessons.
Borrow Kagenti security lessons.
```

## Recommended Next Experiment

### 1. Deploy kagent locally

Goal: verify real UX and nested agent behavior.

Test:

```text
- create ModelConfig for Willow's providers/models
- create two simple Agents: parent + subagent
- connect subagent as A2A tool to parent
- create a tool requiring approval
- confirm nested HITL works
- confirm UI can show live subagent activity
- confirm direct chat to subagent independently
```

### 2. Deploy KAOS separately for UI feel

Goal: decide whether KAOS UI/product flow feels better despite lower maturity.

Test:

```text
- create ModelAPI
- create MCPServer
- create Agent
- use Agent Chat
- inspect Memory
- inspect Pods/logs/YAML
- test A2A delegation
```

### 3. Deploy Agent Sandbox

Goal: learn the hands substrate.

Test:

```text
- create SandboxTemplate for repo toolbox
- create SandboxClaim
- execute command through SDK/router
- test retain/reuse
- test warm pool
```

### 4. Contribution hypothesis

The likely valuable upstream contribution:

```text
kagent + agent-sandbox integration:
    Agent can reference a Workspace/Sandbox-backed ToolServer.
    Multiple agents can share a read-only sandbox/tool pod.
    Writable agents get exclusive sandbox/worktree.
    UI shows hands pod state/logs/tool calls.
    Direct agent room exposes subagent session and hands attachments.
```

This is almost exactly Willow's Hades vision, but as an upstream contribution to the strongest existing ecosystem rather than a new empty repo.

## Final Recommendation

```text
Use kagent as the primary upstream.
Use Kubernetes Agent Sandbox as the hands substrate.
Do not build Hades as a competing platform right now.
Keep Hades specs as a design notebook / contribution plan.
```

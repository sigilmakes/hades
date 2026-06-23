# 12 — Programmatic Subagent Spawning

The Hades vision requires that subagents be spawnable **programmatically** — by a script, CI job, orchestrator agent, or human via API — not only predeclared in YAML. This document isolates that one axis and re-ranks the candidates.

## The Axis

Desired capability:

```text
A process (script/CI/LLM/human) can ask the control plane:
    "create N ephemeral agent runs from a template/class,
     route work to them, observe events, collect results,
     enforce depth/concurrency/allow-list guardrails,
     approve risky actions, and tear them down."

This must be callable from code, not only from the model's tool surface.
```

## Capability Matrix

| Capability | kagent | Orka | Kelos | Ark | KAOS | Kagenti |
|---|---|---|---|---|---|---|
| Predeclared A2A subagent tools | yes | yes | n/a | yes (agents as tools) | yes (agentNetwork) | yes |
| Dynamic LLM tool to create child agent runs | partial (Agent tools are static) | yes (`delegate_task`, `create_agent_task`, `create_ai_task`, `create_container_task`) | yes (TaskSpawner creates Tasks) | yes (Query targets, agents-as-tools) | no first-class | unknown |
| Programmatic REST API to spawn tasks/agents | yes (`POST /api/tasks`, `/api/agents`) | yes (`POST /api/v1/tasks`, fork, events, approvals, artifacts) | yes (`kelos run`, Task CRD, TaskSpawner CRD) | yes (Query CRD, `ark agent query`) | yes (`kaos agent invoke`) | yes (workloads) |
| Depth/concurrency/allow-list guardrails on children | no first-class | yes (maxDepth, allowedAgents, maxConcurrentChildren, controller-enforced) | yes (maxConcurrency, maxTotalTasks, branch mutex) | partial (team strategies) | no | partial |
| Child task status tracked on parent | partial (subagent session metadata) | yes (`status.childTasks[]`) | yes (dependsOn, results passing) | yes (team/member coordination) | no | unknown |
| Execution event stream per task | yes (A2A events, session events) | yes (`GET /tasks/{id}/events`, `/stream`) | yes (pod logs, task status) | yes (ark-broker streaming) | partial | partial |
| HITL approvals on spawned children | yes (nested HITL propagation) | yes (task approvals API) | no first-class | partial | no | partial |
| Ephemeral workspaces/hands per spawned agent | partial (sandbox/substrate in progress) | yes (agent-sandbox integration, RuntimeClass, workspace git) | yes (Workspace CRD, worktree, token refresh) | no first-class | no | yes (agent-sandbox) |
| Coding-agent runtimes (Claude/Codex/Copilot/Gemini) | via BYO image | yes (first-class runtimes) | yes (first-class image interface) | via execution engines | no | via containers |
| Programmatic fan-out + result aggregation | via A2A client | yes (`wait_for_tasks`, autonomous coordinator loop) | yes (dependsOn pipelines, result templates) | yes (Teams + Query) | no | partial |

## Finding

For the **programmatic subagent spawning** axis specifically:

```text
1. Orka     strongest match — dynamic delegation tools + REST task API +
             controller-enforced guardrails + child status + event stream +
             approvals + agent-sandbox hands + coding runtimes
2. Kelos    strong for coding-agent task pipelines via TaskSpawner/dependsOn,
             but oriented to Git/issue/PR triggers more than live orchestration
3. Ark      strong for declarative Teams/Queries and agents-as-tools, less for
             ephemeral live spawning with guardrails
4. kagent   strong A2A/HITL/UI/registry foundation, but subagents are mostly
             predeclared; dynamic spawning is not first-class
5. KAOS     lightweight, mostly static agent network
6. Kagenti  governance/identity focus, not dynamic spawning first-class
```

This inverts the general ranking on this single axis.

## Orka Evidence

Orka exposes a real task control plane:

```text
POST   /api/v1/tasks                     create task/agent run
POST   /api/v1/tasks/{id}/fork           fork a task
GET    /api/v1/tasks/{id}/events         execution events
GET    /api/v1/tasks/{id}/stream         live event stream
GET    /api/v1/tasks/{id}/approvals      HITL approvals
POST   /api/v1/tasks/{id}/approvals/{approvalID}/decision
GET    /api/v1/tasks/{id}/artifacts      artifacts
```

LLM orchestrator tools (also callable patterns for programmatic clients):

```text
delegate_task(agent, prompt, workspace)
create_agent_task(agentRef, prompt, workspace)   coding agent + git workspace
create_ai_task(prompt)                           LLM-only agent
create_container_task(image, command)            isolated container
wait_for_tasks(tasks)                            aggregate results
send_message / check_messages                    inter-agent messaging
update_plan                                      autonomous loop plan state
```

Controller-enforced guardrails:

```text
maxDepth                 reject children beyond depth
allowedAgents            reject delegation to non-allow-listed agents
maxConcurrentChildren    requeue when sibling count at limit
ChildTaskStatus          parent status lists each child's phase/result
```

Autonomous mode:

```text
coordinator runs in a loop, delegates, updates plan, terminates on
goal/limit/cancel
```

Agent runtimes:

```text
Claude Code CLI, OpenAI Codex CLI, GitHub Copilot CLI
with workspace git clone, pushBranch, PR creation
```

Hands substrate:

```text
experimental upstream Kubernetes Agent Sandbox integration
RuntimeClass (gvisor/kata) for isolation
```

This is very close to the Hades "programmatic subagent society" model.

## Updated Recommendation

The recommendation now splits by primary axis:

```text
If the primary goal is a mature, well-adopted A2A agent registry/UI with
nested HITL and predeclared subagents:
    use kagent

If the primary goal is programmatic spawning of ephemeral coding/analysis
subagents with guardrails, child tracking, approvals, event streams, and
agent-sandbox hands:
    use Orka (despite low adoption) OR contribute the missing dynamic-spawn
    layer to kagent
```

## Honest Risk Note on Orka

Orka has very low public adoption (~7 stars, single primary author). That is a real sustainability risk for depending on it as a base. Two mitigation paths:

```text
A. Use Orka as a reference/prototype base and accept the risk.
B. Use kagent as the stable foundation and contribute an Orka-style dynamic
   task/subagent spawning layer to kagent upstream.
```

Path B is likely the best long-term OSS strategy: kagent's adoption + Orka's programmatic orchestration model.

## Proposed Contribution Shape (if extending kagent)

```text
New CRDs:
    AgentTemplate / AgentClass        reusable agent spec
    AgentRun                          ephemeral run from a template
    AgentClaim                        request an ephemeral agent from a pool

New API:
    POST /api/agenttemplates/{name}/run        spawn a run
    POST /api/runs/{id}/delegate               spawn a child run
    GET  /api/runs/{id}/events                 execution events
    POST /api/runs/{id}/approvals              HITL
    GET  /api/runs/{id}/children               child runs

Controller:
    enforce maxDepth, allowedTemplates, maxConcurrentChildren
    track childRuns on parent run status
    ownerReferences for cascade cleanup
    idle/sleep + wake for long-lived sessions

Tools exposed to orchestrator agents:
    spawn_agent(template, input)
    wait_for_agents(runIds)
    message_agent(runId, message)

UI:
    run tree with child runs
    direct chat to any child run
    approvals across the tree
```

This is essentially porting Orka's orchestration model into kagent's registry/UI/A2A foundation.
# 14 — Build vs Borrow

Hades should build only the novel core.

## Build

```text
AgentOS CRDs and controllers
pi SDK brain runtime
brain/hands tool router
per-agent listener model
schedule/self-modification model
capability/syscall layer
durable event/session store
programmatic spawn with guardrails
direct agent room UX/API
```

## Borrow

```text
Kubernetes                    runtime substrate
controller-runtime/kubebuilder controllers
Postgres                      event/projection store
OpenTelemetry                 traces/metrics/logs
Kubernetes Agent Sandbox      hands substrate where useful
gVisor/Kata                   isolation runtime
MCP                           tool server protocol
ACP/A2A                       agent wire compatibility
KAOS                          UI taste/reference
Orka                          dynamic spawn/guardrail reference
Kelos                         workspace/Git workflow reference
kagent                        MCP/A2A/HITL/platform reference
Kagenti                       identity/security reference
```

## Avoid

```text
custom container orchestrator
custom secret store
custom tracing system
custom vector database in v0
custom dashboard state separate from API
pi TUI internals as host substrate
hidden subagent orchestration inside one model tool call
```

## Relationship to Existing Platforms

Existing platforms validate the direction but do not combine:

```text
strict brain/hands split
pi SDK brain runtime
per-agent listeners and schedules
agent userland/home model
programmatic subagent spawning with guardrails
direct agent rooms and hands attach
```

So Hades is justified as a small novel core over existing primitives.

## Discipline

```text
kernel boring
agents weird
controllers deterministic
system agents intelligent
userland mutable
sessions durable
hands disposable
```

# 15 — AgentOS Primitives

Hades should feel like an operating system, but it should not expose every host primitive to agents. This document records what the autoresearch loop found useful, deferred, and noisy.

## Rule

```text
Expose semantics to agents.
Compile semantics to substrate primitives.
Do not hand agents raw substrate power.
```

## Adopt Now

```text
Scripting sandbox (execute(name, input) -> string)
  -> HandsBackend.exec under a SandboxProfile
  -> confined-local profile now; container-isolated profile when real isolation exists

Linux namespaces/cgroups/capabilities/seccomp
  -> SandboxProfile inputs for the container-isolated profile

Mounts and volume projection
  -> Home, workspace, scratch, SecretLease

Timers/cron
  -> Schedule

Per-agent listener routing
  -> Listener now; future Gateway provider daemon when behavior exists

Paired device nodes
  -> Node + declared caps/commands

Brokered MCP tools
  -> ToolProvider + policy-filtered catalog

ACP external harness sessions
  -> ExternalSession + Run integration

Permission/tool hooks
  -> Approval + CapabilityGrant + event log, not arbitrary kernel plugins
```

The hand interface is `execute(name, input) -> string`: a name and input go in, a string comes out. The harness does not know whether the sandbox is a container, a phone, or an emulator. This is the Managed Agents primitive and the OpenClaw/Claude Code convergence point. Workflows are *not* here: they live in userland.

## Defer

```text
inotify/fanotify
  Useful for reactive indexing and project automation, but not first-loop critical.

voice wake / talk mode
  Valuable for resident agents, but belongs at Node/Gateway edge.

live canvas / A2UI-style visual surface
  Useful control-room surface, not kernel core until API/events stabilize.

workflow DAGs
  Harness/userland orchestration over subagents and scripts, not a kernel resource.
  Claude Code ships them as a feature next to subagents and agent teams; provide stable
  execute/session/wake interfaces and let workflows live in userland.
```

## Reject

```text
raw D-Bus
  Too broad. Use narrow Node/Gateway commands.

raw ptrace/perf
  Sandbox escape hazard. Only through special human-approved debugging profiles.

per-agent MCP sidecar sprawl
  Credential and policy sprawl. Use brokered ToolProviders.
```

## Candidate Resource Surface

These are likely future resource kinds, but v0 does **not** promote them to CRDs or state-visible kinds until behavior exists:

```text
Gateway
Node
ToolProvider
Workflow
ExternalSession
SandboxProfile
SecretLease
```

A resource kind is a public API promise. Hades should not ossify speculative nouns just because the ontology can name them. Keep candidates in the primitive catalog/spec with `implementation: "future"` until there is a controller, syscall, status contract, or meaningful projection to own.

## Gateway Model

OpenClaw validates the idea of one long-lived gateway owning many real messaging surfaces. Hades borrows the shape but keeps the attachment point per-agent:

```text
Gateway/cluster-local
  owns provider connections and node transport

Listener/agent-wren-discord
  binds Gateway capability to Agent/wren + Session/default

Node/phone
  declares voice/camera/location/canvas commands after pairing
```

## Tool Model

MCP should be brokered:

```text
Agent brain
  -> hades tool adapter
  -> ToolProvider broker
  -> policy/cooldown/audit
  -> MCP server or ACP-transport MCP server
```

Do not mount every MCP server into every agent pod.

## ACP Model

ACP is the bridge to external harnesses, not the internal Hades brain protocol:

```text
Workflow step
  -> ExternalSession(runtime: acp, agent: claude|codex|openclaw|pi)
  -> structured events and cancellation
  -> results back into Hades Session/Run
```

This avoids PTY scraping and lets Hades coordinate Claude Code, Codex, OpenClaw, Gemini, or future ACP-compatible agents as peers.

## Linux Model

Linux primitives are implementation knobs for sandbox/runtime profiles:

```text
SandboxProfile
  namespaces: pid/mount/user/net/ipc/uts
  cgroups: cpu/memory/pids/io
  seccomp: profile
  capabilities: drop all, add narrow set only when approved
  mounts: Home/workspace/scratch/secrets with explicit modes
```

Agents request capabilities like `createOwnTool` or `requestHands`. They do not request `CAP_SYS_ADMIN`.

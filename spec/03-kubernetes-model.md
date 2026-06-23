# 03 — Kubernetes Model

Hades is Kubernetes-native. Its runtime objects should be visible through `kubectl`, reconciled by controllers, and backed by normal cluster primitives.

## Namespace Model

```text
wire-system / hades-system
    Hades API server
    Hades controllers
    Hades scheduler
    event store
    dashboard service
    cluster-wide CRDs

project-* namespaces
    AgentSessions
    AgentRuns
    BrainPods
    HandsPods
    Workspaces
    project-specific policies
```

Example:

```text
hades-system
project-auth-redesign
project-docs-audit
project-research-cri3
```

## Core CRDs

### AgentClass

Reusable template for a type of agent.

```yaml
apiVersion: hades.dev/v1alpha1
kind: AgentClass
metadata:
  name: planner
spec:
  description: Plans implementation strategy and decomposes tasks.
  brain:
    image: ghcr.io/sigilmakes/hades-brain-pi:latest
    modelPolicy:
      default: anthropic/claude-sonnet-4-6
      allowed:
        - anthropic/claude-sonnet-4-6
        - ollama/glm-5.2:cloud
  instructionsRef:
    configMap: planner-instructions
  tools:
    allowed:
      - read
      - grep
      - write-proposal
      - acp-send
      - await-approval
  handPolicy:
    defaultMode: shared-readonly
    writableRequiresApproval: true
  resources:
    brain:
      cpu: "1"
      memory: 2Gi
```

### AgentSession

Durable identity of an agent. May or may not currently have a live brain pod.

```yaml
apiVersion: hades.dev/v1alpha1
kind: AgentSession
metadata:
  name: planner-auth-001
spec:
  classRef: planner
  project: auth-redesign
  sessionLogRef: sess-auth-planner-001
  workspaceRefs:
    - repo-auth-main
  desiredState: active
status:
  phase: awaiting
  brainPod: brain-planner-auth-001-7c8f
  hands:
    - repo-auth-readonly
  runRefs:
    - run-plan-auth-flow
  lastEventId: 128
```

### BrainPodBinding

Binds an AgentSession to a live brain pod.

```yaml
apiVersion: hades.dev/v1alpha1
kind: BrainPodBinding
metadata:
  name: planner-auth-001
spec:
  agentSessionRef: planner-auth-001
  brainImage: ghcr.io/sigilmakes/hades-brain-pi:latest
  sessionLogRef: sess-auth-planner-001
status:
  phase: running
  podName: brain-planner-auth-001-7c8f
  startedAt: "2026-06-21T12:00:00Z"
```

### HandsPod

Represents a tool/sandbox environment.

```yaml
apiVersion: hades.dev/v1alpha1
kind: HandsPod
metadata:
  name: repo-auth-readonly
spec:
  type: repo-toolbox
  sharing: shared
  workspaceRef: repo-auth-main
  writable: false
  tools:
    - bash
    - read
    - rg
    - git-status
    - test-readonly
status:
  phase: ready
  podName: hands-repo-auth-readonly-5d9b
  attachedAgents:
    - planner-auth-001
    - explorer-auth-002
```

### Workspace

```yaml
apiVersion: hades.dev/v1alpha1
kind: Workspace
metadata:
  name: repo-auth-main
spec:
  source:
    git:
      url: git@github.com:org/app.git
      ref: main
  mode: readonly
  volume:
    size: 20Gi
status:
  phase: ready
  revision: abc123
```

Writable worktree:

```yaml
apiVersion: hades.dev/v1alpha1
kind: Workspace
metadata:
  name: wt-auth-coder-001
spec:
  source:
    workspaceRef: repo-auth-main
  mode: writable-worktree
  branch: hades/coder/auth-refresh
  ownerAgentRef: coder-auth-001
status:
  phase: ready
  baseRevision: abc123
  headRevision: def456
```

### AgentRun

ACP-compatible run state.

```yaml
apiVersion: hades.dev/v1alpha1
kind: AgentRun
metadata:
  name: run-plan-auth-flow
spec:
  agentSessionRef: planner-auth-001
  inputRef: event-42
  mode: stream
status:
  phase: awaiting
  acpStatus: awaiting
  awaitRequestRef: approval-17
  outputRefs:
    - event-88
```

### Approval

```yaml
apiVersion: hades.dev/v1alpha1
kind: Approval
metadata:
  name: approval-17
spec:
  requesterRef: agent/planner-auth-001
  runRef: run-plan-auth-flow
  prompt: Allow planner to modify the auth flow?
  options:
    - approve
    - deny
    - approve-with-constraints
status:
  phase: pending
```

### Artifact

```yaml
apiVersion: hades.dev/v1alpha1
kind: Artifact
metadata:
  name: auth-design-report
spec:
  sessionRef: planner-auth-001
  contentType: text/markdown
  uri: s3://hades-artifacts/project-auth/auth-design-report.md
status:
  phase: available
```

## Controller Loops

### AgentSession Controller

```text
watch AgentSession
    if desiredState=active and no BrainPodBinding:
        create BrainPodBinding
    if desiredState=sleeping and brain exists:
        checkpoint + terminate brain pod
    if brain pod crashed:
        create replacement and wake(sessionId)
    update status from event store and pod health
```

### HandsPod Controller

```text
watch HandsPod
    if workspace not ready:
        wait
    if pod missing and desired ready:
        create pod with requested tools/workspace
    if pod unhealthy:
        mark degraded, optionally replace
    if no attached agents and ttl expired:
        terminate
```

### Workspace Controller

```text
watch Workspace
    if git source:
        clone/fetch into PVC or ephemeral volume
    if worktree source:
        create branch/worktree from base workspace
    if owner done and merge requested:
        prepare patch/PR/merge proposal
```

### AgentRun Controller

```text
watch AgentRun
    created -> ensure agent active
    in-progress -> stream events
    awaiting -> create/update Approval if needed
    cancelling -> signal brain/hands
    terminal -> finalize outputs/artifacts
```

### Scheduler

The Hades scheduler decides:

```text
- which AgentClass to instantiate
- which model/provider to use
- which node pool should host brain pod
- which hands pod can be shared
- whether a writable isolated workspace is required
- whether a browser/MCP/GPU/special runtime is needed
- budget/resource limits
- locality to workspace/cache
```

Scheduling flow:

```text
AgentRun requested
      │
      v
┌──────────────────┐
│ Hades Scheduler  │
└───────┬──────────┘
        │
        ├─ validate policy
        ├─ select AgentClass
        ├─ select model/provider
        ├─ select namespace
        ├─ create/wake AgentSession
        ├─ create BrainPodBinding
        ├─ bind existing HandsPod or create new one
        ├─ bind Workspace
        └─ emit run.created
```

## Kubernetes Object Graph

```text
AgentClass/planner
       │
       │ instantiates
       v
AgentSession/planner-auth-001 ───────┐
       │                              │
       │ has live brain                │ uses
       v                              v
BrainPodBinding/planner-auth-001   HandsPod/repo-auth-readonly
       │                              │
       │ creates                       │ mounts
       v                              v
Pod/brain-planner-7c8f             Workspace/repo-auth-main
       │
       │ owns runs
       v
AgentRun/run-plan-auth-flow
       │
       │ may await
       v
Approval/approval-17
```

## Local Development Cluster

The smallest deployment should still use Kubernetes.

```text
laptop
  └─ k3s or kind
       ├─ hades-system
       │   ├─ hades-api
       │   ├─ hades-controller
       │   ├─ postgres or sqlite-pvc prototype
       │   └─ dashboard service
       └─ project-default
           ├─ brain pods
           ├─ hands pods
           └─ workspace PVCs
```

## Why Not tmux as the Substrate?

Tmux remains valuable as an attach mechanism and local terminal UX, but not as the orchestrator.

```text
tmux gives:
    terminal multiplexing
    human attach
    simple process persistence

kubernetes gives:
    scheduling
    health checks
    restart policy
    namespaces
    resource limits
    RBAC
    network policy
    declarative state
    controllers
    portable scale-out
```

Hades can expose tmux-like UX on top of Kubernetes pod exec/PTY streams.

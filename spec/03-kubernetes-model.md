# 03 — Kubernetes Model

Hades is Kubernetes-native. The resources should be visible through `kubectl`, reconciled by controllers, and backed by normal cluster primitives.

## Namespaces

```text
hades-system
  hades-api
  hades-controller-manager
  hades-store
  secret broker adapters
  system agents
  cluster-wide CRDs

agent-wren / project-* / team-*
  Agents
  Sessions
  Homes
  Listeners
  Schedules
  Hands
  Workspaces
  CapabilityGrants
```

For a single resident Wren deployment:

```text
hades-system
agent-wren
```

For larger teams:

```text
hades-system
project-auth
project-docs
agent-wren
agent-muse
```

## Core CRDs

### Agent

```yaml
apiVersion: hades.dev/v1alpha1
kind: Agent
metadata:
  name: wren
  namespace: agent-wren
spec:
  classRef: resident-pi
  homeRef: wren-home
  defaultSession: default
  desiredState: active
  modelPolicy:
    default: ollama-cloud/qwen
  listeners:
    - wren-discord
  schedules:
    - morning-ritual
status:
  phase: active
  brainPod: brain-wren-6b8c
  sessions:
    - default
```

### AgentClass

Reusable template for an agent type.

```yaml
kind: AgentClass
spec:
  brainImage: ghcr.io/sigilmakes/hades-brain-pi:latest
  systemPromptRef:
    configMap: resident-wren-prompt
  allowedTools:
    - read
    - write
    - bash
    - os.createSchedule
    - os.spawnAgent
  defaultHandsPolicy: home-sandbox
```

### Home

```yaml
kind: Home
metadata:
  name: wren-home
spec:
  volume:
    size: 50Gi
  layout:
    create:
      - vault
      - bin
      - cron.d
      - projects
      - skills
status:
  phase: ready
  pvc: home-wren-pvc
```

### Session

```yaml
kind: Session
metadata:
  name: wren-default
spec:
  agentRef: wren
  logRef: sess-wren-default
status:
  phase: idle
  lastEventId: evt_000123
```

### BrainBinding

```yaml
kind: BrainBinding
metadata:
  name: wren-default
spec:
  agentRef: wren
  sessionRef: wren-default
  image: ghcr.io/sigilmakes/hades-brain-pi:latest
status:
  phase: running
  podName: brain-wren-6b8c
```

### Hands

```yaml
kind: Hands
metadata:
  name: wren-home-shell
spec:
  type: home-toolbox
  mode: exclusive
  homeRef: wren-home
  tools:
    - bash
    - read
    - write
    - edit
    - git
  isolation:
    runtimeClassName: gvisor
status:
  phase: ready
  podName: hands-wren-home-shell-82cf
```

### Listener

```yaml
kind: Listener
metadata:
  name: wren-discord
spec:
  agentRef: wren
  platform: discord
  secretRef: wren-discord-token
  routes:
    - external: "1333841182794580112"
      session: default
  allowedUsers:
    - sigil__
    - mankymeson
status:
  phase: connected
```

### Schedule

```yaml
kind: Schedule
metadata:
  name: morning-ritual
spec:
  agentRef: wren
  cron: "0 7 * * *"
  session: default
  promptRef:
    homePath: cron.d/morning-ritual.md
  notify:
    - listenerRef: wren-discord
      target: "1333841182794580112"
```

### Run

```yaml
kind: Run
metadata:
  name: run-20260623-001
spec:
  agentRef: wren
  sessionRef: wren-default
  inputEventRef: evt_000124
  mode: stream
status:
  phase: completed
```

### CapabilityGrant

```yaml
kind: CapabilityGrant
metadata:
  name: wren-self-management
spec:
  subject:
    kind: Agent
    name: wren
  capabilities:
    - updateOwnHome
    - createOwnSchedule
    - createOwnTool
    - spawnChildAgent
  constraints:
    namespaces:
      onlyOwn: true
    maxChildDepth: 2
```

## Object Graph

```text
Agent/wren
  ├─ Home/wren-home
  ├─ Session/wren-default
  │   └─ BrainBinding/wren-default -> Pod/brain-wren-*
  ├─ Listener/wren-discord -> Pod/listener-discord-*
  ├─ Schedule/morning-ritual
  └─ Hands/wren-home-shell -> Pod/hands-wren-*
```

## Controllers

```text
AgentController       desiredState -> BrainBinding
BrainController       BrainBinding -> Pod lifecycle
HomeController        Home -> PVC/layout/bootstrap
HandsController       Hands -> sandbox/tool pod
ListenerController    Listener -> bridge pod
ScheduleController    Schedule -> timer -> run/message
RunController         Run -> session events -> brain wake
CapabilityController  grants -> policy cache/RBAC projections
GarbageCollector      TTL cleanup with retention rules
```

## Why Not tmux

Tmux is an attach UX, not the substrate.

```text
tmux gives terminals
k8s gives namespaces, pods, services, RBAC, network policy, PVCs, controllers, health, scale
```

Hades can expose tmux-like attach for brain/hands pods through Kubernetes exec/PTY streams.

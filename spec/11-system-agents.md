# 11 — System Agents

System agents are privileged userland daemons that manage Hades. They are
agents with elevated (but scoped) capabilities — never blanket cluster-admin.

## The design rule

```text
if a behavior requires judgment          -> system agent (privileged userland)
if a behavior requires deterministic     -> controller (boring reconciler)
   desired-state convergence
```

The `KubeController` is the deterministic reconciler. System agents are the
intelligent operators on top: they call the same `os.*` syscalls ordinary
agents do, but with broader grants.

## The three system agents

```mermaid
flowchart LR
    subgraph sys["hades-system namespace"]
        PROV["provisioner"]
        JAN["janitor"]
        AUD["auditor"]
    end
    PROV -->|creates| R["agents · homes ·<br/>listeners · schedules"]
    JAN -->|cleans| X["expired hands ·<br/>completed runs"]
    AUD -->|reviews| P["policy · exposure ·<br/>drift · findings"]
```

| Agent | Capabilities | Role |
|-------|--------------|------|
| `provisioner` | `createAgent`, `createHome`, `attachListener`, `createOwnSchedule`, `spawnAgent` | Creates ordinary agents, homes, listeners, and schedules from requests. |
| `janitor` | `deleteExpiredHands`, `deleteExpiredRuns`, `listResources`, `emitArtifact` | Cleans expired hands, completed runs, orphaned resources. |
| `auditor` | `readPolicy`, `listResources`, `emitArtifact`, `requestApproval` | Reviews capabilities, secrets, exposure, drift; surfaces findings. |

## Bootstrapping

`SystemAgents.reconcile()` is idempotent: it ensures the three agents, their
homes, and their scoped grants exist in the `hades-system` namespace. Their
actual intelligence runs in brain pods like any agent; this only bootstraps the
resources and grants.

```mermaid
flowchart TD
    REC["Reconciler.reconcile()"]
    SA["SystemAgents.reconcile()"]
    ENS["ensure agent + home + grant<br/>for each of provisioner/janitor/auditor"]
    REC --> SA --> ENS
```

## Recursive agents

Any agent with `spawnAgent` may spawn child agents if policy permits. A
resident agent spawning a helper is process spawning, not hidden tool
execution — the child is a real, inspectable `Agent` resource.

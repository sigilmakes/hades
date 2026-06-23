# 12 — System Agents

Hades can run agents that manage Hades. These are privileged userland processes, not kernel code.

## Why

A real OS has system daemons and admin processes. Hades should too.

```text
kernel controllers = boring reconcilers
system agents      = intelligent operators using scoped capabilities
```

## Initial System Agents

### provisioner

Creates ordinary agents, homes, listeners, and schedules from human requests.

Capabilities:

```text
createAgent
createHome
attachListener
createSchedule
grantBasicCapabilities
```

### janitor

Cleans expired hands, completed runs, orphaned resources, and stale projections.

Capabilities:

```text
deleteExpiredHands
deleteExpiredRuns
listResources
emitReport
```

### auditor

Reviews capabilities, secrets, listener exposure, network policies, and dangerous drift.

Capabilities:

```text
readPolicy
readMetadata
readAuditEvents
createFinding
requestApproval
```

### librarian

Indexes homes, vaults, session summaries, docs, and repos into searchable memory.

Capabilities:

```text
readApprovedHomePaths
writeIndex
searchMemory
scheduleIndexJob
```

### backup

Snapshots homes, session store, artifacts, and CRDs.

Capabilities:

```text
snapshotHome
snapshotEventStore
snapshotArtifacts
verifyRestore
```

## Provisioning Example

```text
Willow -> provisioner:
  create an agent named Muse with email and Discord

provisioner:
  os.createAgent(muse)
  os.createHome(muse-home)
  os.attachListener(muse-email)
  os.attachListener(muse-discord)
  os.createSchedule(inbox-review)
```

Controllers reconcile the resulting CRDs.

## Recursive Agents

Agents may spawn child agents if policy permits.

```text
Wren:
  os.spawnAgent(class=librarian, name=wren-librarian)
  os.grantCapability(writeIndexOnly)
  os.createSchedule(daily-index)
```

This is process spawning, not hidden tool execution.

## Guardrails

System agents must not receive blanket cluster-admin by default.

```text
max namespaces
allowed resource kinds
approval for destructive operations
no session-content access unless granted
secret operations through broker only
audit every syscall
```

## Design Rule

If a behavior requires judgment, make it a system agent. If it requires deterministic desired-state convergence, make it a controller.

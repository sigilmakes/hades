# 09 — Security and Policy

Hades must preserve self-modification without letting prompt injection become cluster-admin.

## Credential Boundary

Credentials live behind the kernel/secret broker, not in hands.

```text
Brain pod:    may request model/API credentials through SDK/broker
Hands pod:    no model auth, no raw provider tokens
Home PVC:     no kernel secrets
Listener pod: platform token scoped to listener
SecretBroker: resolves secrets for authorized operations
```

## Capabilities

Use typed capabilities above Kubernetes RBAC.

Examples:

```text
updateOwnHome
createOwnTool
createOwnSchedule
spawnChildAgent
messageAgent
attachListener
createHands
readSessionContent
readSessionMetadata
approveAction
rotateSecret
createNamespace
```

## CapabilityGrant

```yaml
kind: CapabilityGrant
spec:
  subject:
    kind: Agent
    name: wren
  capabilities:
    - updateOwnHome
    - createOwnTool
    - createOwnSchedule
  constraints:
    namespace: own
    maxScheduleFrequency: "*/5 * * * *"
    networkProfiles:
      - restricted-web
```

## Policy Checks

Every syscall and tool route checks:

```text
subject identity
requested capability
resource ownership
namespace boundary
network profile
secret scope
approval requirement
budget/concurrency limit
audit requirement
```

## Approvals

Approvals are resumable gates.

```text
approval.requested
approval.responded
run.resumed
```

Approvals should support:

```text
approve
deny
approve-with-constraints
edit response
expire
escalate
```

## Network Policy

Hands should use default-deny egress with explicit profiles:

```text
none               no egress
restricted-web     HTTPS/DNS only
project-services   selected services
lan-denied         block RFC1918 except allowlist
full-web           explicit approval required
```

## Filesystem Policy

Mounts should be explicit:

```text
home: read-write for owner hands
kernel agentDir: never mounted into hands
workspace: mode governed by Hands spec
secrets: projected only into broker/proxy where required
```

## System Agents

System agents receive elevated capabilities, never blanket cluster-admin by default.

```text
provisioner: createAgent, createHome, attachListener
janitor: deleteExpiredHands, deleteExpiredRuns
auditor: readPolicy, readMetadata, reportFindings
backup: snapshotHome, snapshotEventStore
```

## Audit

Audit events must include:

```text
who requested
what capability
which resource
input hash / output hash when sensitive
approval ref if applicable
trace id
policy decision
```

## Human Override

Humans with appropriate capability can:

```text
pause agent
sleep agent
cancel run
revoke listener
freeze schedule
detach hands
snapshot home
```

## Principle

Agents may grow their userland. They may not silently mutate the kernel or escape their capability domain.

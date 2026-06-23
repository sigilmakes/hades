# Hades

Hades is a Kubernetes-native **agent operating system**: a minimal control plane for running long-lived AI agents as addressable, inspectable, restartable compute.

The design center is not "an agent in a pod." It is an OS model:

```text
Agent        = process / user
Home         = persistent filesystem
Session      = durable event log
Brain        = model + harness loop, via pi SDK
Hands        = disposable sandbox/tool environment
Listener     = terminal / device / bridge
Schedule     = cron timer
Tool         = syscall / capability
Capability   = permission
Controller   = kernel daemon
SystemAgent  = privileged userland process
```

Core invariants:

- Kubernetes is the runtime substrate from the start.
- Hades is a control plane, not a pi extension and not a single tool call.
- Brain pods use the pi SDK in-process; they do not spawn `pi --mode rpc` inside a sandbox.
- Brains, hands, sessions, listeners, homes, schedules, and capabilities are separate resources.
- Agent self-modification is supported through scoped OS APIs: agents may edit their home, create tools, create schedules, and spawn child agents when policy permits.
- Durable session/event logs outlive every brain and hands pod.
- Humans can inspect, steer, pause, resume, attach to, and talk directly to any authorized agent.

Start with [`spec/00-index.md`](spec/00-index.md).

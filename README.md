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

## Current Prototype

The repo contains a TypeScript control-plane prototype that exercises the v0 AgentOS loop locally while keeping Kubernetes resources as the deployable shape.

```bash
npm install
npm test
./bin/hades demo
```

For day-to-day local use from a checkout:

```bash
./bin/hades init
./bin/hades up examples/generic/alpha.json
./bin/hades say agent-demo/demo "!write vault/hello.md <<<hello"
./bin/hades say agent-demo/demo "!read vault/hello.md"
./bin/hades tail demo-default
./bin/hades serve
```

`./bin/hades` builds `dist/` if needed. After packaging or `npm link`, use `hades` directly.

## Brain Mode

The default brain mode is **pi SDK**. The SDK path registers Hades tools (`hades_read`, `hades_write`, `hades_bash`) that route through Hands; it does not expose pi's local filesystem tools to the brain. In the local prototype, `hades_bash` is deliberately confined to Home-relative executables and rejects absolute paths, `..`, shell metacharacters, executable symlinks, and shell/interpreter shebangs. Real Kubernetes hands should replace this with pod/runtime isolation.

The generic demo pins `spec.brain.mode: deterministic` so tests and smoke demos run offline without model credentials. You can also force offline mode with:

```bash
HADES_BRAIN_MODE=deterministic ./bin/hades say agent-demo/demo "hello"
```

Wren is an example manifest under `examples/wren/`; the default demo uses `examples/generic/`. Core runtime code does not default to Wren or `agent-wren`.

## Core invariants

- Kubernetes is the runtime substrate from the start.
- Hades is a control plane, not a pi extension and not a single tool call.
- Brain pods use the pi SDK in-process; they do not spawn `pi --mode rpc` inside a sandbox.
- Brains, hands, sessions, listeners, homes, schedules, and capabilities are separate resources.
- Agent self-modification is supported through scoped OS APIs: agents may edit their home, create tools, create schedules, and spawn child agents when policy permits.
- Durable session/event logs outlive every brain and hands pod.
- Humans can inspect, steer, pause, resume, attach to, and talk directly to any authorized agent.

Start with [`spec/00-index.md`](spec/00-index.md).

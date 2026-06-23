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

This repo now contains a dependency-light Node prototype that exercises the full v0 loop locally while keeping Kubernetes resources as the deployable shape.

```bash
npm install
npm test
npm run demo
```

Useful commands:

```bash
npm run build
HADES_DATA_DIR=.hades node dist/cli.js init
HADES_DATA_DIR=.hades node dist/cli.js apply examples/generic/alpha.json
HADES_DATA_DIR=.hades node dist/cli.js message agent-demo/demo "!write vault/hello.md <<<hello"
HADES_DATA_DIR=.hades node dist/cli.js message agent-demo/demo "!read vault/hello.md"
HADES_DATA_DIR=.hades node dist/cli.js events demo-default
HADES_DATA_DIR=.hades node dist/cli.js serve 7347
```

Set `HADES_USE_PI_SDK=1` to run the brain through the pi SDK adapter. Default mode is deterministic so tests and controller flows do not require model credentials.

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

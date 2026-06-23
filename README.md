# Hades

Hades is a Kubernetes-native agent operating system: a control plane for managing long-running AI agents as distributed, observable, restartable compute.

The core decisions are fixed:

- Kubernetes is the runtime substrate from the start.
- ACP is the public agent communication protocol.
- Pi SDK sessions provide agent brain/harness execution, not the pi TUI extension surface.
- Agent brains and agent hands are separate pods.
- Durable session/event logs outlive every brain and hands pod.
- Humans can directly inspect, steer, pause, resume, and talk to any agent.

Start with the spec:

- [`spec/00-index.md`](spec/00-index.md)


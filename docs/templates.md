# Agent Templates

Spin-up is one command: `hades new <template> <name>` renders a prebaked
manifest (Home + Agent + optional Listener + CapabilityGrant), substitutes your
name/namespace/vars, and applies it.

```mermaid
flowchart LR
  Cmd["hades new discord-bot mybot<br/>--set token-secret=..."] --> Tmpl["examples/templates/<br/>discord-bot.yaml"]
  Tmpl -->|substitute {{name}} {{namespace}} {{vars}}| Manifest["4 resources"]
  Manifest --> Apply["hades apply + reconcile"]
```

## Usage

```bash
hades new discord-bot mybot --namespace agent-mybot --set token-secret=mybot-token
hades new cron-worker nightly --namespace agent-nightly --set prompt="Summarize the day"
```

Then create any referenced Secret (for listeners):

```bash
kubectl create secret generic mybot-token --from-literal=token=... -n agent-mybot
```

## Built-in templates

| Template | Includes | Vars |
|---|---|---|
| `discord-bot` | Home, Agent, Discord Listener, CapabilityGrant | `token-secret` |
| `cron-worker` | Home, Agent, Schedule (cron), CapabilityGrant | `prompt` |

Templates live in [`examples/templates/`](../examples/templates). Add your own
by dropping a `.yaml` there with `{{name}}`, `{{namespace}}`, and `{{var}}`
tokens.

See also: [Resources](resources.md), [Listeners](listeners.md), [Web UI](web-ui.md).

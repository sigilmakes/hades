# 13 — V0 Loop

The first implementation must prove one loop. Everything else is deferred.

## One Loop

```text
local k3s
  -> create Agent/wren
  -> create Home/wren-home
  -> create Listener/cli or Discord
  -> create Schedule/morning
  -> send message to wren
  -> controller wakes brain pod
  -> brain runs pi SDK with real model
  -> brain calls bash/read/write through hands pod
  -> hands returns result
  -> events are durable
  -> human can message wren directly
  -> wren creates or updates one schedule through os.createSchedule
  -> brain crash recovers from session log
  -> hands crash becomes tool error
```

If this works, Hades has a reason to exist.

## Minimal Components

```text
hades-api
  /agents /runs /sessions /events /approvals
  basic syscalls

hades-controller
  Agent, Session, BrainBinding, Hands, Home, Listener, Schedule

hades-brain-pi
  pi SDK runtime
  custom Hades tools

hades-hands-home
  bash/read/write/edit for one Home PVC

hades-store
  Postgres event store

hades-cli
  install, apply examples, message agent, tail events
```

UI can start as CLI/TUI. Web waits until the API loop is stable.

## Deferred

```text
multi-node scheduling
complex budget accounting
federation
many providers
advanced dashboard
Agent Sandbox deep integration if a simple pod suffices for first proof
A2A bridge
email/matrix listeners
system agents beyond provisioner stub
```

## First Acceptance Tests

```text
[ ] kind/k3s cluster boots Hades
[ ] kubectl get agents shows wren
[ ] hades message agent/wren "hello" streams response
[ ] hades events tail shows raw events
[ ] brain pod can be deleted and recovers
[ ] hands pod can be deleted and next tool call reports/recreates
[ ] wren writes ~/bin/hello in Home through hands
[ ] wren creates Schedule/test-once through syscall
[ ] schedule fires and creates a session event
[ ] no model credential is mounted into hands pod
```

## First Non-Goal

Do not build a beautiful dashboard before the loop exists. The dashboard must wrap real APIs, not invent state.

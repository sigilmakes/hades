# 11 — UI / UX

Hades needs an operations UI, not a decorative transcript overlay.

## Principle

> If an agent exists, the human can see it, select it, inspect it, and talk to it.

## Required Surfaces

```text
hades tui       terminal control room
hades web       browser dashboard
hades cli       scriptable operations
hades chat      direct agent conversation
hades attach    attach to brain/hands/listener streams
hades logs      event replay
hades top       cluster overview
```

## Main Control Room

```text
┌──────────────────────────────── Hades ────────────────────────────────┐
│ Cluster local-k3s │ Namespace agent-wren │ Agent wren │ 2 listeners  │
├─────────────────────────────┬───────────────────────┬────────────────┤
│ Agent Tree                  │ Userland              │ Inspector      │
│                             │                       │                │
│ ● wren            active ◀  │ Home: wren-home       │ Selected: wren │
│ ├─● brain/default  01m22s   │ Vault: clean          │ Model: qwen    │
│ ├─● hands/home     ready    │ bin/: 27 tools        │ Session: default│
│ ├─● discord        connected│ cron.d/: 18 jobs      │ Brain: brain-* │
│ └─○ matrix         disabled │ Schedules: 5 active   │ Hands: home    │
│                             │                       │ Context: 42%   │
├─────────────────────────────┴───────────────────────┴────────────────┤
│ Activity                                                               │
│ 07:00 schedule/morning fired                                           │
│ 07:00 listener/discord delivered morning hello                         │
│ 10:45 schedule/recess delayed by active conversation                   │
│ 10:52 os.createTool ~/bin/vault-random approved                        │
├───────────────────────────────────────────────────────────────────────┤
│ To wren > _                                                            │
│ Enter send │ Ctrl+A approvals │ Ctrl+H hands │ Ctrl+L listeners │ Tab │
└───────────────────────────────────────────────────────────────────────┘
```

## Agent Room

```text
┌──────────────────────── Agent Room: wren/default ──────────────────────┐
│ State active │ Brain brain-wren-6b8c │ Home wren-home │ Model qwen      │
├──────────────────────── Transcript / Events ───────────────────────────┤
│ Willow: good morning bird                                              │
│ Wren: morning. weather says rain. deeply on-brand.                     │
│ schedule/recess: due in 14m                                            │
│ Wren -> os.createSchedule: night-sketch                                │
│ approval: create weekly schedule?                                      │
├──────────────────────── Input ─────────────────────────────────────────┤
│ To wren > approve the schedule but make it Saturdays only _            │
└────────────────────────────────────────────────────────────────────────┘
```

## Listener Room

```text
┌──────────────────────── Listener: wren-discord ────────────────────────┐
│ Platform discord │ State connected │ Agent wren │ Session default      │
├────────────────────────────────────────────────────────────────────────┤
│ Routes                                                                 │
│ 1333841182794580112 -> default                                         │
│ Allowed users: sigil__, mankymeson                                     │
├────────────────────────────────────────────────────────────────────────┤
│ Recent                                                                  │
│ 12:00 recv sigil__: can you check this?                                │
│ 12:00 delivered response, 2 chunks                                      │
└────────────────────────────────────────────────────────────────────────┘
```

## Hands Room

```text
┌──────────────────────── Hands: wren-home-shell ────────────────────────┐
│ Type home-toolbox │ Mode exclusive-home │ Runtime gvisor │ Ready        │
├────────────────────────────────────────────────────────────────────────┤
│ Mounts: /home/wren rw, /tmp rw                                         │
│ Tools: bash read write edit git rg python node                         │
├────────────────────────────────────────────────────────────────────────┤
│ Recent calls                                                           │
│ wren bash ~/bin/drives --translate                         ok 0.2s     │
│ wren edit ~/cron.d/recess.md                               ok 0.1s     │
├────────────────────────────────────────────────────────────────────────┤
│ $ _                                                                    │
└────────────────────────────────────────────────────────────────────────┘
```

## Anti-Patterns

Forbidden:

```text
hidden subagents visible only as tool text
no direct message path to subagents
UI actions that are not API-backed
hiding Kubernetes state
hiding listener/schedule/hands health
cosmetic dashboard with no control
```

Required:

```text
full-screen operational views
direct agent chat
hands attach
listener inspection
schedule management
approval queue
event replay
kubectl-compatible object state
```

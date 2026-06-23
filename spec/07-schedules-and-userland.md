# 07 — Schedules and Userland

Wren's old crons were one of the best parts of the system. Hades makes them first-class.

## Schedule as OS Primitive

A Schedule is a timer that injects a prompt or syscall into an agent.

```yaml
kind: Schedule
metadata:
  name: recess
spec:
  agentRef: wren
  cron: "45 10,14,18 * * *"
  gracePeriod: 30m
  session: default
  promptRef:
    homePath: cron.d/recess.md
  notify:
    - listenerRef: wren-discord
      target: "1333841182794580112"
```

## Agent-Authored Schedules

Agents may create or modify schedules through capabilities:

```text
os.createSchedule(...)
os.updateSchedule(...)
os.deleteSchedule(...)
```

This preserves autonomy while making changes visible, validated, and auditable.

## Home Layout

A resident agent's home is userland:

```text
/home/wren
  vault/       memory, notes, identity, daily logs
  bin/         self-authored tools
  cron.d/      prompt bodies and schedule source material
  projects/    repos and creative work
  skills/      reusable procedural instructions
  inbox/       listener attachments
  outbox/      files to send
```

The kernel does not dictate the content. It only provides lifecycle, persistence, and policy.

## Wren Reference Pattern

Old Wren proved useful patterns:

```text
morning ritual    wake + orient + say hello + do something
meta cron         update STATUS/MEMORY + review schedules
dream cron        consolidate session logs into daily memory
recess            short random play/explore/build loop
vault-sync        silent git commit/push
```

Hades should support these without hardcoding them.

## Userland Mutation

Allowed examples:

```text
write ~/bin/vault-random
edit ~/cron.d/recess.md
create Schedule/recess
append ~/vault/44-daily/2026-06-23.md
clone project into ~/projects/foo
```

Not allowed without explicit capability:

```text
edit kernel controller deployment
read model provider secret
attach listener to another agent
delete another agent's home
create privileged hands pod
```

## Schedule Execution Flow

```text
ScheduleController sees cron due
        │
        v
checks grace/interaction policy
        │
        v
appends schedule.fired
        │
        v
creates Run or message event
        │
        v
wakes brain if needed
        │
        v
routes output through notify listeners
```

## Grace Periods

Schedules should avoid trampling active human conversation.

```text
if active listener conversation and gracePeriod not expired:
    delay
else:
    fire
```

## Source of Truth

Schedule CRD is the executable desired state. Prompt files in Home are editable userland source.

A controller can reconcile `cron.d/*.md` into Schedule resources, or schedules can directly reference prompt bodies. The first prototype can choose one, but the spec should support both.

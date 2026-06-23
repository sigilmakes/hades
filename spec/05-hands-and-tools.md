# 05 — Hands and Tools

Hands are execution environments. Tools are the syscalls brains use to affect the world.

## Hands Pod

A hands pod is disposable and replaceable.

```text
Hands Pod
  ├─ shell
  ├─ mounted home/workspace subset
  ├─ language runtimes
  ├─ tests/build tools
  ├─ browser/MCP processes if requested
  └─ tool server endpoint
```

It does not contain model credentials or brain auth.

## Hands Types

```text
home-toolbox        Wren-style home/bin/vault editing
repo-readonly       shared grep/read/test-safe workspace
repo-worktree       exclusive writable coding worktree
browser             browser automation and screenshots
mcp-proxy           local MCP server with brokered auth
python-lab          notebooks/science scripts
media-lab           ffmpeg/whisper/audio/image tools
minecraft-client    embodied game client
custom              user-defined image
```

## Tool Call Flow

```text
Brain                         Hades API                  Hands
  │                              │                         │
  │ tool.requested               │                         │
  ├─────────────────────────────>│                         │
  │                              │ authorize + select hand │
  │                              ├────────────────────────>│
  │                              │                         │ execute
  │                              │<────────────────────────┤ stdout/stderr
  │<─────────────────────────────┤ stream events           │
  │                              │<────────────────────────┤ completed
  │<─────────────────────────────┤ result/error            │
```

The model sees a normal tool result. The system sees every event.

## Built-In Tool Surface

The pi SDK brain should not use local built-in filesystem tools directly for untrusted execution. Hades provides custom tool adapters:

```text
read(path)        -> hands read
write(path, data) -> hands write
edit(...)         -> hands edit
bash(command)     -> hands execute
rg(query)         -> hands rg
attach(file)      -> listener outbound artifact
```

## User-Created Tools

Agents may create tools in their Home:

```text
~/bin/vault-random
~/bin/blog-stats
~/bin/drives
~/bin/perception-check
```

This is normal userland. The kernel should support it.

Execution path:

```text
agent writes ~/bin/foo
agent calls bash("foo ...")
Hades routes to home-toolbox hands
hands executes ~/bin/foo
result returns through event log
```

## Tool Installation Policy

Creating a tool is different from granting it broad privileges.

```text
write ~/bin/foo             allowed by updateOwnHome
run ~/bin/foo               allowed by bash/home-toolbox
call external network       governed by hands NetworkPolicy
read kernel secret          impossible; not mounted
create Kubernetes resource  only via OS syscall + capability
```

## Hands Failure

If a hands pod crashes:

```text
execute -> pod dies -> tool.failed -> brain receives error
```

The brain may retry, request a new hand, ask a human, or continue.

## Sharing Modes

```text
shared-readonly       many brains, no writes
exclusive-worktree    one writer, optional readers
exclusive-home        one agent editing its own home
ephemeral-command     one-off dangerous execution
shared-service        browser/MCP/db style service
sensitive-exclusive   data/credential-adjacent environment
```

## Substrate

Hades should use Kubernetes Agent Sandbox where practical, and normal pods/jobs where the sandbox project does not yet fit.

Do not build a custom isolation runtime unless forced.

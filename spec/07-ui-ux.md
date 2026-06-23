# 07 — UI/UX

Hades needs a real operations UI. Not a floating box inside another chat UI. Not a summary blob. Not a hidden workflow tool.

The UI must make the distributed system legible and controllable.

## UX Principle

> If an agent exists, the human can see it, select it, inspect it, and talk to it.

The dashboard is a control room for a live Kubernetes-backed agent system.

## Required Surfaces

```text
hades tui       full-screen terminal dashboard
hades web       KAOS-style browser dashboard for teams
hades cli       scriptable operations interface
hades chat      direct agent conversation
hades attach    attach to brain/hands terminal streams
hades logs      event/log replay
hades top       resource/status overview
```

## KAOS-Inspired Web UX

KAOS has the right product feel for the web surface: a Kubernetes resource dashboard that remains friendly and explorable. Hades should borrow that vibe directly while extending it for brain/hands separation and direct agent steering.

Borrow:

```text
- namespace-scoped home dashboard
- cards for agent/model/tool resource health
- resource list pages
- resource detail pages with tabs
- direct agent chat tab
- memory/session/event inspector
- MCP/tool debug tab
- model connectivity debug tab
- pod list and live pod logs
- YAML viewer/editor
- global search
- visual map of connected resources
- CLI command that opens web UI through local proxy
```

Architecture target:

```text
┌─────────────┐     ┌────────────────┐     ┌─────────────────┐
│ Browser UI  │────▶│ hades ui proxy │────▶│ Kubernetes API  │
│ static app  │     │ localhost      │     │ + Hades API     │
└─────────────┘     └────────────────┘     └─────────────────┘
```

The browser should not store raw kube credentials. The local `hades ui` command can use the current kubeconfig/RBAC and proxy safe requests.

## Main Dashboard

```text
┌────────────────────────────────────────── Hades ────────────────────────────────────────────┐
│ Cluster local-k3s │ Namespace project-auth │ Run auth-redesign │ 67% │ $1.24 │ 3 active   │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│ [● feature/auth 67%] [◐ fix/login 23%] [○ docs idle]       Mode: LIVE      User: Willow    │
├──────────────────────────┬──────────────────────────────┬───────────────────────────────────┤
│ Agent Tree               │ Tasks / Blockers             │ Inspector                         │
│                          │                              │                                   │
│ ● main          2m34s    │ [✓] Explore authentication   │ Selected: agent/planner           │
│ ├─● explorer    0m45s    │ [→] Design auth flow         │ State: awaiting approval          │
│ │ ├─✓ grep      0m12s    │     blocked by approval-17   │ Model: claude/sonnet              │
│ │ └─✓ summarize 0m18s    │ [ ] Implement refresh logic  │ Brain: brain-planner-8x2          │
│ ├─◐ planner     1m02s ◀  │ [ ] Write integration tests  │ Hands: wt-auth-design             │
│ ├─● coder       0m22s    │ [ ] Update documentation     │ Workspace: wt/auth-design         │
│ └─○ reviewer    pending  │                              │ Context: ███████░░░ 67%           │
│                          │                              │ Tokens: 45,230 in / 12,891 out   │
├──────────────────────────┴──────────────────────────────┴───────────────────────────────────┤
│ Activity                                                                                    │
│ 12:34:01 [main]       spawned planner                                                       │
│ 12:34:03 [explorer]   Tool:rg "refreshToken" src/**                                         │
│ 12:34:05 [planner]    Awaiting approval-17: allow auth-flow modifications?                  │
│ 12:34:08 [coder]      Tool:bash npm test -- auth                                            │
│ 12:34:10 [hands/wt]   stderr: 2 failing tests                                               │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│ To planner > _                                                                              │
│ Enter send │ Ctrl+R approve/resume │ Ctrl+T attach hands │ Ctrl+K cancel │ Tab cycle panes │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Direct Agent Room

Selecting an agent and pressing Enter opens the agent room.

```text
┌──────────────────────────── Agent Room: planner ─────────────────────────────┐
│ State: awaiting    Run: auth-redesign    Session: sess-planner-auth-001      │
│ Brain: brain-planner-72d9f    Hands: repo-auth-ro, wt-auth-design            │
├──────────────────────────── Transcript / Session Events ─────────────────────┤
│ user/main: Design the auth refresh fix.                                      │
│ planner: I will inspect token refresh boundaries first.                      │
│ planner -> explorer: Map refreshToken usage.                                 │
│ explorer: Found TokenManager.ts and AuthMiddleware.ts.                       │
│ planner: I need approval before modifying auth flow.                         │
│ planner awaits approval-17.                                                  │
├──────────────────────────── Current Await ───────────────────────────────────┤
│ Allow planner to modify auth flow files?                                     │
│ Files proposed:                                                              │
│   src/auth/TokenManager.ts                                                   │
│   src/auth/AuthMiddleware.ts                                                 │
│                                                                              │
│ [a] approve  [d] deny  [e] edit response  [o] open diff                      │
├──────────────────────────── Input ───────────────────────────────────────────┤
│ To planner > approve, but preserve compatibility and add tests _             │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Hands Room

```text
┌──────────────────────────── Hands Pod: wt-auth-design ─────────────────────────────┐
│ Type: repo-toolbox       Mode: exclusive-worktree      State: ready                │
│ Pod: hands-wt-auth-design-559f       Node: k3s-worker-1                            │
├──────────────────────────── Workspace ─────────────────────────────────────────────┤
│ /workspace/repo     git@github.com:org/app.git                                     │
│ Branch              hades/planner/auth-design                                      │
│ Base                main@abc123                                                    │
│ Dirty               yes, 2 files changed                                           │
├──────────────────────────── Tools ─────────────────────────────────────────────────┤
│ bash  read  edit  rg  git  npm-test  tree                                          │
├──────────────────────────── Recent Calls ──────────────────────────────────────────┤
│ 12:34:03 explorer  rg "refreshToken" src/**                          ok   0.4s    │
│ 12:34:08 coder     npm test -- auth                                  fail 9.1s    │
│ 12:34:21 planner   read src/auth/TokenManager.ts                     ok   0.1s    │
├──────────────────────────── Terminal Attach ───────────────────────────────────────┤
│ $ _                                                                               │
└───────────────────────────────────────────────────────────────────────────────────┘
```

## Approval Queue

```text
┌──────────────────────────── Approvals ────────────────────────────┐
│ ID          Agent       Request                         Age        │
│ approval-17 planner     modify auth flow                00:42      │
│ approval-18 coder       run migration against dev DB    00:11      │
├───────────────────────────────────────────────────────────────────┤
│ Selected: approval-17                                             │
│                                                                   │
│ Requested action:                                                 │
│   Write to auth flow files in workspace wt-auth-design             │
│                                                                   │
│ Risk: medium                                                      │
│ Files:                                                            │
│   src/auth/TokenManager.ts                                        │
│   src/auth/AuthMiddleware.ts                                      │
│                                                                   │
│ [a] approve   [d] deny   [e] edit response   [g] go to agent      │
└───────────────────────────────────────────────────────────────────┘
```

## Cluster Top View

```text
┌──────────────────────────────── Hades Top ────────────────────────────────┐
│ AGENT              STATE      MODEL        BRAIN POD       HANDS    COST   │
│ planner-auth-001   awaiting   sonnet       brain-plan-8x   2        $0.40  │
│ coder-auth-001     running    codex-mini   brain-code-2d   1        $0.22  │
│ reviewer-auth-001  sleeping   haiku        -               1        $0.01  │
│ explorer-auth-002  running    glm-cloud    brain-exp-91    1        $0.03  │
├────────────────────────────────────────────────────────────────────────────┤
│ HANDS              STATE      MODE                  ATTACHED      AGE       │
│ repo-auth-ro       ready      shared-readonly       3 agents      12m       │
│ wt-auth-design     ready      exclusive-worktree    planner       4m        │
│ browser-preview    degraded   shared-service        coder         1m        │
└────────────────────────────────────────────────────────────────────────────┘
```

## Event Replay View

```text
┌──────────────────────────── Session Log sess-auth-001 ────────────────────────────┐
│ 0001 12:33:59 session.created         main                                        │
│ 0002 12:34:00 message.created         user        redesign auth flow              │
│ 0003 12:34:01 agent.spawned           main        planner                         │
│ 0004 12:34:02 brain.woke              planner     brain-planner-8x2               │
│ 0005 12:34:03 tool.requested          explorer    rg refreshToken                 │
│ 0006 12:34:03 tool.completed          hands-ro    17 matches                      │
│ 0007 12:34:05 approval.requested      planner     approval-17                     │
│ 0008 12:34:10 approval.responded      willow      approved with constraints       │
└───────────────────────────────────────────────────────────────────────────────────┘
```

## UX Anti-Patterns

Forbidden:

```text
- floating overlay that obscures a chat transcript
- subagents visible only as lines in a tool result
- no direct message path to a subagent
- dashboards that cannot affect the running system
- hiding Kubernetes object state
- hiding tool pod health
- hiding approval/blocker state
```

Required:

```text
- full-screen dashboard
- all actions backed by API calls
- keyboard-first navigation
- mouse/web later, not required for first TUI
- direct agent chat
- attach to hands
- approval/resume flows
- event replay
- cluster/object inspection
```

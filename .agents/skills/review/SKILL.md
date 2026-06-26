---
name: review
description: Review changes against feature/integration before opening a PR or when the user asks for review. Checks correctness, the kernel/userland boundary, edge cases, regressions, test gaps, and resource-kind checklist compliance.
---

# Review

Review the current changes before they leave the branch. Catch problems here,
not in PR comments.

## What to review

Both uncommitted changes and commits not on the base:

```bash
git status -sb
git diff --stat
git branch --show-current
git diff feature/integration...HEAD --stat
git log feature/integration..HEAD --oneline 2>/dev/null
```

If the base is `main`, you're on the wrong line — Hades stacks on
`feature/integration`. Fetch first if local main is stale.

If there's nothing to review, say so and stop.

## Review focus

### The kernel/userland boundary (Hades-specific, highest weight)
- Does any application logic leak into `src/`? A `fetch`, GitHub client, or
  browser in the kernel is wrong — it belongs in a deployed userland image the
  kernel routes to. See the hades-conventions skill.
- Does a new capability respect the three kernel jobs (govern / discover /
  route) without interpreting the body? HTTP is the unifying standard.
- Is logic put in the right layer? Controller reasons about resources + ports;
  only adapters touch k8s.

### New resource kinds
If a kind was added, verify the full checklist (see hades-conventions):
- `KINDS` updated; CRD in both `infra/k8s/crds/` **and** `charts/hades/templates/crds.yaml`
- `buildX` pure fn + `reconcileX` + wired into the loop in the right order
- `HADES_KINDS` updated; finalizer cleanup if it owns native objects
- a `system.<kind>` event; a capability-gated syscall + API route if runtime-created
- a test against `FakeKubeClient`

### Correctness
- Does it do what it claims? Edge cases: empty inputs, single elements, missing
  fields, concurrent reconcile of two Hands targeting one pod.
- Are error paths handled with the right message + status?

### Regressions
- `npm run build && npm test` green? (expect 229 tests, 2 Postgres skip)
- Does a public port signature change without updating callers/adapters?
- `FakeKubeClient` + `KubeClientNode` both updated for a new `KubeClient` method?

### Testing
- New public functions / resource kinds tested?
- Edge cases, not just the happy path?
- Does a test rely on a stale dist? Rebuild (`npm run build`) if unsure.

### Code quality
- Leftover debug prints, commented-out code, TODO without an issue?
- 0 lint errors? (warnings for `Record<string, any>` on open specs are fine)
- Docstrings factual, not rotting implementation detail?

## Report findings

Classify each:

| Severity | Meaning |
|----------|---------|
| **Critical** | Broken behaviour, data loss, security hole, kernel-boundary violation. Must fix. |
| **High** | Likely bug, missing test for an important path, skipped checklist step. Should fix. |
| **Medium** | Minor bug, style inconsistency, fragile pattern. Fix if convenient. |
| **Low** | Nit, opinion. Mention, don't block. |

Summary:

```markdown
## Review: [branch name]

**Files changed:** N
**Base:** feature/integration
**Verdict:** ready / needs fixes / blocked

### Findings

| Severity | File | Issue |
|----------|------|-------|
| critical | path | description |
| ... | ... | ... |

### No significant issues
(If clean, say so explicitly — don't make the user wonder if you skipped it.)
```

## After review

- Critical/High → offer to fix before opening the PR.
- Medium/Low only → note in the PR body, proceed.
- Clean → proceed to open the PR (see make-a-pr skill).
- A durable record is sometimes wanted — post as an issue comment, not a repo
  file, unless Willow asks for one.

## Gotchas

- Compare against `feature/integration`, not `main`.
- A very large branch gives a broad, less precise review — say so if so.
- "Cannot access X before initialization" in a CLI test = a `const` referenced
  above its definition (TDZ) — a recurring Hades footgun.
- Two Hands → one `hands-<agent>` Deployment overwrites; check the agent's
  `handsImageRef`/`security` flows onto the home-shell, not a duplicate Hands.

If posting to GitHub, include `Written by an agent on behalf of Willow.`

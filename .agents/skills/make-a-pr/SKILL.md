---
name: make-a-pr
description: Commit and open a pull request against feature/integration (never main). Use when you have changes ready to submit — after implementing, testing, and self-reviewing.
---

# Make a PR

## Branch

1. Branch from `feature/integration` (the folded line), **not** `main`:
   `git checkout feature/integration && git checkout -b feature/<thing>`.
2. **Never push or merge directly to `main`.** Hades is exploration-only on
   branches. PRs are for review; they don't have to merge.

## Commit

1. One logical change per commit. Lint fix + feature = two commits.
2. Conventional commits: `feat(scope): ...`, `fix(scope): ...`, `docs: ...`,
   `test: ...`, `chore: ...`, `ci: ...`. Scope is often a domain
   (`capabilities`, `ui`, `controller`, `cli`).
3. First line < 50 chars, imperative mood. Body explains the *why* if non-obvious.
4. Reference the issue: `Closes #N` in the commit body or PR body.

## Self-review

```bash
git diff feature/integration...HEAD
```

Check for:
- Leftover debug prints, commented-out code, accidental formatting churn.
- Missing tests for new public functions / resource kinds.
- A new resource kind that skipped the checklist (see hades-conventions skill).
- Changes you don't remember making.

## Pre-push

```bash
npm run build        # tsc, ESM, .js imports — 0 errors
npm test             # 229 tests, 0 failures (2 Postgres skip without DATABASE_URL)
npm run lint         # 0 errors (warnings for Record<string,any> are fine)
```

## Push

```bash
git push -u origin feature/<thing>
```

## Open the PR

```bash
gh pr create --repo sigilmakes/hades --base feature/integration \
  --title "feat(scope): short description" --body-file /tmp/pr-body.md
```

PR body template:

```markdown
## What
One-sentence summary.

## Why
Context + the problem. Reference the issue: Closes #N.

## How to test
- `npm run build && npm test` — expect 229 tests, 0 failures.
- Feature-specific verification (commands, expected output).

## Changes
- The meaningful changes, not every file.

---
Written by an agent on behalf of Willow.
```

## After opening

- Include `Closes #N` so the linked issue closes on merge.
- Inspect CI: `gh pr checks <number> --repo sigilmakes/hades` (Node 24 CI).
- Respond to review by pushing new commits — don't force-push reviewed code.
- If CI is red for an unrelated reason (flake), note it in the PR body.

## Merging

- Merge only after review approval + green CI.
- Most Hades PRs intentionally **stay unmerged** (exploration). Confirm with
  Willow whether a given PR should merge or remain a reference branch.

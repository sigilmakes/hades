---
name: github-cli
description: Use the gh CLI for GitHub issues, PRs, comments, checks, and Actions state in this repo (sigilmakes/hades). Use whenever reading or writing GitHub state from an agent session.
---

# GitHub CLI

Use `gh` for GitHub work. Prefer structured commands over scraping web pages.

Repo: `sigilmakes/hades`

## Rules

- Use `--repo sigilmakes/hades` unless deliberately relying on the current remote.
- Prefer `--json` and `--jq` for reads so output is machine-checkable.
- Use `--body-file` for long issue/comment/PR bodies — don't fight shell quoting.
- Prefer **issue comments** for progress/reviews/decisions/handoffs. Edit issue
  bodies only when the plan/source-of-truth is structurally stale.
- **Never merge feature branches to `main`.** Hades is exploration-only on
  branches; PRs are for review, not for landing on main.
- Any GitHub text an agent writes must include:

```text
Written by an agent on behalf of Willow.
```

## Inspect state

```bash
gh issue list --repo sigilmakes/hades --state open --limit 20
gh pr list --repo sigilmakes/hades --state open --limit 20
gh pr view <number> --repo sigilmakes/hades --json state,mergeStateStatus,isDraft,baseRefName,headRefName
gh pr checks <number> --repo sigilmakes/hades
gh run list --repo sigilmakes/hades --branch <branch>
gh run view <run-id> --repo sigilmakes/hades --log
```

Use `gh api` for fields high-level commands omit:

```bash
gh api repos/sigilmakes/hades/issues/<number> --jq '{title, state, body}'
gh api repos/sigilmakes/hades/pulls/<number> --jq '{title, mergeable, rebaseable}'
```

## Create an issue

```bash
cat > /tmp/issue-body.md <<'EOF'
## Problem
...

## Approach
...

## Acceptance criteria
- [ ] ...

---
Written by an agent on behalf of Willow.
EOF

gh issue create --repo sigilmakes/hades --title "type: short title" --body-file /tmp/issue-body.md
```

## Comment on an issue

Comments are timeline records — progress, reviews, verification, decisions,
blockers, handoffs. Use them over body edits for anything that's new history.

```bash
cat > /tmp/comment.md <<'EOF'
## Done
- ...

## Next
- ...

---
Written by an agent on behalf of Willow.
EOF

gh issue comment <number> --repo sigilmakes/hades --body-file /tmp/comment.md
```

## Create a PR

Hades stacks on `feature/integration` — base your PRs there, not `main`.

```bash
git status -sb
git branch --show-current
gh pr list --repo sigilmakes/hades --head "$(git branch --show-current)"

cat > /tmp/pr-body.md <<'EOF'
## What
...

## Why
Closes #<issue-number>.

## How to test
- `npm run build && npm test` — expect 229 tests, 0 failures.
- (any feature-specific verification)

## Changes
- ...

---
Written by an agent on behalf of Willow.
EOF

gh pr create --repo sigilmakes/hades --base feature/integration --title "feat(scope): short title" --body-file /tmp/pr-body.md
```

## Edit existing GitHub text

```bash
gh issue view <number> --repo sigilmakes/hades --json body --jq .body > /tmp/body.md
# edit /tmp/body.md
gh issue edit <number> --repo sigilmakes/hades --body-file /tmp/body.md
```

For comments:

```bash
gh api repos/sigilmakes/hades/issues/<issue-number>/comments --jq '.[] | {id, body: .body[0:120]}'
gh api repos/sigilmakes/hades/issues/comments/<comment-id> -X PATCH -f body="$(cat /tmp/comment.md)"
```

## Checks and Actions

```bash
gh pr checks <number> --repo sigilmakes/hades
gh run list --repo sigilmakes/hades --branch <branch>
gh run view <run-id> --repo sigilmakes/hades --log
```

CI exists (`.github/workflows/ci.yml`): Node 24, `npm ci && build && test`.

## Gotchas

- `gh pr create --base feature/integration` — the default base is `main`, which
  you must override or the PR targets the wrong base.
- `gh issue edit --body-file` replaces the whole body. Fetch first.
- Ask before editing a body: "plan change, or just history?" History → comment.

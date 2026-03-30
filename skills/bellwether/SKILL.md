---
name: bellwether
description: >-
  Bring the current PR to a mergeable state: CI green, all review comments resolved,
  no merge conflicts. Self-contained — watches CI, fixes issues, watches again until
  merge-ready. Use when the user wants to keep a PR green, auto-fix CI, resolve
  review comments, or says "get this merged".
user-invocable: true
---

# Bellwether — Drive PR to Merge-Ready

Self-contained cycle: watch CI → fix failures → address reviews → watch again → until merge-ready.

## Critical: Use the bellwether CLI

- The ONLY way to check CI status, PR state, and reviews is `npx -y bellwether check --watch`. This command blocks until CI completes or the watch times out — do NOT add sleep or polling. Use `--timeout` to extend the wait; never resort to manual polling.
- NEVER use `gh api`, `gh pr checks`, `gh pr view --json`, `gh api repos/*/check-runs`, or any manual GitHub API calls to check CI or review status.
- NEVER use `sleep` to wait for CI. The `--watch` flag handles waiting internally.
- NEVER parse review comments manually via `gh api`. The bellwether CLI returns them in structured format.
- The bellwether CLI is an npm package — `npx -y bellwether` ensures it's installed and runs it.
- Every interaction with GitHub goes through the bellwether CLI. Zero manual GitHub API usage.

## The Loop

```
1. npx -y bellwether check --watch        (blocks until CI completes or the watch times out; DO NOT substitute with gh/GitHub API calls — use this exact command)
2. If pr.ready=true → done, report "merge-ready"
3. If pr.state=merged|closed → done, report status
4. If CI failures → fix them (Step 2), push, go to 1
5. If unresolved reviews → address them (Step 3), push, go to 1
6. If pr.mergeable=dirty|behind → /sync, push, go to 1
7. If timed out → go to 1 (restart watch)
```

## What `npx -y bellwether check --watch` returns

Three sections:

- **pr** — `state` (open/closed/merged), `mergeable` (clean/dirty/behind/blocked/unstable), `ready` (true when all conditions met)
- **ci** — SHA, check summary, and for each failing check: the filtered error log with file paths and line numbers
- **reviews** — unresolved review comments with full body, file path, and line number

## Step 2: Fix CI failures

For each `FAIL` key in the CI section:

1. **Read the error log** — it contains actual compiler/test output with file paths and line numbers.
2. **Fix the code** — minimal change that resolves the root cause.
3. **Verify locally** — run the same check that failed.
4. **Stage, commit, push** — stage files by name (never `git add -A`).
5. **Go to step 1** — restart the watch. New CI runs, new bot comments may arrive.

## Step 3: Address review comments

For each `REVIEW` key in the reviews section:

### Classify

**Bot comments** (CodeRabbit, Copilot, Cursor Bugbot):
- **True positive** — real bug → fix the code
- **False positive** — bot doesn't understand the pattern → won't fix
- **Uncertain** — ask the user

**Human comments**:
- **Actionable** — fix the code
- **Discussion** — ask the user
- **Already addressed** — reply only

### Fix and commit

Fix all true positives and actionable items in a single commit. Verify locally, push.

### Reply

For inline code review comments (with file path), reply individually with `--resolve`:

```bash
npx -y bellwether check --reply "<id>:Fixed in <hash>. <description>" --resolve
```

For top-level bot comments (no file path), post a single summary reply:

```
Addressed review findings in <hash>:
- REVIEW 456: Fixed null check in src/foo.ts
- REVIEW 789: Won't fix — pattern is intentional
```

Every comment gets a response. Use `--resolve` on every reply.

After all replies, go to step 1 — restart the watch.

## Principles

- **One fix per watch cycle** — fix CI OR reviews, not both. Push and restart watch.
- **Minimal changes** — don't refactor unrelated code.
- **Every comment gets a response** — no silent ignores.
- **Ask when uncertain** — don't guess on architectural questions.
- **Verify before pushing** — always run the failing check locally first.
- **Never stop until terminal** — if `pr.ready` is false, keep going.

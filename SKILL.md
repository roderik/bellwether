---
name: bellwether
description: >-
  Bring the current PR to a mergeable state: CI green, all review comments resolved,
  no merge conflicts. Single check-and-fix cycle designed to run via /loop
  (e.g., /loop 1m /bellwether). Use when the user wants to keep a PR green,
  auto-fix CI, resolve review comments, or says "get this merged".
user-invocable: true
---

# Bellwether — PR Check-and-Fix Cycle

Run `bellwether check` to get PR state, CI status, and review comments in one call. Fix what's broken, push, stop. The next cycle picks up the new state.

## Step 1: Gather state

```bash
bellwether check
```

This returns three sections:

- **pr** — `state` (open/closed/merged), `mergeable` (clean/dirty/behind/blocked/unstable), `ready` (boolean — true only when all conditions met)
- **ci** — SHA, check summary, and for each failing check: the filtered error log
- **reviews** — unresolved review comments with full body, file path, and line number

### Terminal states

| `pr.ready` | Meaning | Action |
|---|---|---|
| `true` | CI green, zero unresolved reviews, mergeable=clean | PR is merge-ready. Cancel cron, stop. |
| `false` | Something needs attention | Continue to Step 2/3/4 |

| `pr.state` | Action |
|---|---|
| `merged` or `closed` | Cancel cron, stop. |
| `open` | Continue. |

| `pr.mergeable` | Action |
|---|---|
| `dirty` | Merge conflicts — run `/sync` to rebase, push, stop. |
| `behind` | Branch behind main — run `/sync`, push, stop. |
| `blocked` | Required reviews or merge conflicts — check `dirty` first. |
| `clean` / `unstable` / `has_hooks` | No merge issues — continue. |
| `unknown` | GitHub still computing — stop, next cycle re-checks. |

If checks are still pending (0 failing, N pending), stop — the next cycle will re-check.

## Step 2: Fix CI failures

For each `FAIL` key in the CI section:

1. **Read the error log** — it contains the actual output (TypeScript errors, test failures, lint violations) with file paths and line numbers.
2. **Fix the code** — make the minimal change that resolves the root cause.
3. **Verify locally** — run the same check that failed.
4. **Stage, commit, push** — stage files by name (never `git add -A`), commit with a descriptive message, push.
5. **Stop** — the push triggers new CI. The next cycle verifies it passed.

Do NOT continue to Step 3 after pushing CI fixes. New bot review comments will arrive from the push. The next cycle handles them.

## Step 3: Address review comments

For each `REVIEW` key in the reviews section:

### Classify

**Bot comments** (CodeRabbit, Copilot, Cursor Bugbot):
- **True positive** — real bug → fix the code
- **False positive** — bot doesn't understand the pattern → won't fix
- **Uncertain** — ask the user via `AskUserQuestion`

**Human comments**:
- **Actionable** — fix the code
- **Discussion** — unclear approach → ask the user
- **Already addressed** — reply only

### Fix and commit

1. Fix all true positives and actionable items in a single commit
2. Run local checks to verify
3. Stage files by name, commit, push

### Reply — single shared comment for top-level reviews

After pushing, reply to all comments in a **single batch comment** on the PR rather than one reply per comment. This reduces notification noise and keeps the PR timeline clean.

For inline code review comments (with a file path), use individual replies with `--resolve`:

```bash
bellwether check --reply "<id>:Fixed in <hash>. <description>" --resolve
```

For top-level PR comments from bots (no file path), post a single summary reply addressing all findings:

```
Addressed review findings in <hash>:
- REVIEW 456: Fixed null check in src/foo.ts
- REVIEW 789: Won't fix — pattern is intentional (uses fallback by design)
- REVIEW 123: Fixed type mismatch in src/bar.ts
```

Every comment gets a response — no silent ignores. Use `--resolve` on every reply to close the thread.

## Step 4: Watch (optional)

For continuous monitoring between cycles:

```bash
bellwether check --watch
```

Polls until CI reaches a terminal state, then returns PR state + CI + reviews. Use this when waiting for CI after a push instead of sleeping.

## Principles

- **One fix per cycle** — fix CI OR reviews, not both. Push and let the next cycle verify.
- **Minimal changes** — don't refactor unrelated code.
- **Every comment gets a response** — replies train bots and document decisions.
- **Ask when uncertain** — don't guess on architectural questions.
- **Verify before pushing** — always run the failing check locally first.
- **Never exit unmonitored** — if the PR is not merge-ready and no cron is running, keep checking.

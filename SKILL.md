---
name: bellwether
description: >-
  Bring the current PR to a mergeable state: CI green, all review comments resolved.
  Single check-and-fix cycle designed to run via /loop (e.g., /loop 1m /bellwether).
  Use when the user wants to keep a PR green, auto-fix CI, or resolve review comments.
user-invocable: true
---

# Bellwether — PR Check-and-Fix Cycle

Run `bellwether check` to get CI status and review comments in one call. Fix what's broken, push, stop. The next cycle picks up the new state.

## Step 1: Gather state

```bash
bellwether check
```

This returns two sections:

- **ci** — SHA, check summary, and for each failing check: the filtered error log (actual compiler/test output, not GitHub metadata)
- **reviews** — unresolved review comments with full body, file path, and line number

If all checks pass and zero reviews are unresolved, the PR is merge-ready. Cancel any active cron job and stop.

If checks are still pending (0 failing, N pending), stop — the next cycle will re-check.

## Step 2: Fix CI failures

For each `FAIL` key in the CI section:

1. **Read the error log** — it contains the actual output (TypeScript errors, test failures, lint violations). The file paths and line numbers are in the log.
2. **Fix the code** — make the minimal change that resolves the root cause.
3. **Verify locally** — run the same check that failed (e.g., `bun check`, `bun run test`, `bun run build`).
4. **Stage, commit, push** — stage files by name (never `git add -A`), commit with a descriptive message, push.
5. **Stop** — the push triggers new CI. The next cycle verifies it passed.

Do NOT continue to Step 3 in the same cycle after pushing CI fixes. New bot review comments will arrive from the push. The next cycle handles them.

## Step 3: Address review comments

For each `REVIEW` key in the reviews section:

### Classify

**Bot comments** (CodeRabbit, Copilot, Cursor Bugbot, etc.):
- **True positive** — real bug (null check, type mismatch, logic error) → fix the code
- **False positive** — bot doesn't understand the pattern → won't fix, note the reason
- **Uncertain** — ask the user via `AskUserQuestion`

**Human comments**:
- **Actionable** — fix the code
- **Discussion** — unclear approach → ask the user
- **Already addressed** — reply only

### Fix, commit, push

1. Fix all true positives and actionable items
2. Run local checks to verify nothing is broken
3. Stage files by name, commit: `fix: address PR review findings`
4. Push

### Reply and resolve

After pushing, reply to every comment and resolve the thread:

```bash
bellwether check --reply "<id>:Fixed in <commit-hash>. <brief description>" --resolve
```

- True positive: `"Fixed in abc1234. Added null check for config parameter"`
- False positive: `"Won't fix: this pattern is intentional — <explanation>" --resolve`
- Every comment gets a response — no silent ignores

## Step 4: Watch loop (optional)

For continuous monitoring, use watch mode:

```bash
bellwether check --watch
```

This polls until CI reaches a terminal state (all pass or all fail), then returns both CI and review state. Use this when waiting for CI after a push instead of sleeping and re-running.

## Principles

- **One fix per cycle** — fix CI OR reviews, not both. Push and let the next cycle verify.
- **Minimal changes** — don't refactor unrelated code. A CI fix is just a CI fix.
- **Every comment gets a response** — replies train bots and document decisions.
- **Ask when uncertain** — don't guess on architectural questions or business logic.
- **Verify before pushing** — always run the failing check locally before pushing.

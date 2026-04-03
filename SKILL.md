---
name: bellwether
description: >-
  Bring the current PR to a mergeable state: CI green, all review comments resolved,
  no merge conflicts. Self-contained — watches CI, fixes issues, watches again until
  merge-ready. Use when the user wants to keep a PR green, auto-fix CI, resolve
  review comments, or says "get this merged".
user-invocable: true
allowed-tools: Bash(npx bellwether *) Bash(bunx bellwether *) Bash(bellwether *) Bash(npm install -g bellwether) Bash(git add *) Bash(git commit *) Bash(git push *) Bash(git status) Bash(git diff *) Bash(git log *) Bash(bun *) Bash(npm *) Read Edit Write Glob Grep
---

# Bellwether — Drive PR to Merge-Ready

Self-contained cycle: watch CI -> the instant work appears, fix it -> push -> watch again -> until merge-ready.

IMPORTANT: Execute ALL work in the main thread. Do NOT use the Agent tool, Task tool, or spawn sub-agents. Track all state in your working memory (context window). This skill runs as a sequential loop — you fetch, evaluate, fix, commit, reply, then loop.

## Critical: Use the bellwether CLI

- The ONLY way to check CI status, PR state, and reviews is `bellwether check --watch`. This command returns only when the PR is actually merge-ready (`pr.ready=true`), when actionable work appears (CI failures, unresolved reviews, merge conflicts), when the PR reaches a terminal state (`merged` or `closed`), or on timeout. It keeps polling while the PR is still not ready but there is nothing local to fix yet, including pending external checks and `mergeable=blocked|unstable|unknown`. Do NOT add sleep or polling.
- **`pending` or `in_progress` CI is NOT success, NOT "probably fine", and NOT a reason to stop.** It means the loop is still running. Keep `bellwether check --watch` in control until it returns actionable work or `pr.ready=true`.
- NEVER use `gh api`, `gh pr checks`, `gh pr view --json`, `gh api repos/*/check-runs`, or any manual GitHub API calls to check CI or review status.
- NEVER use `sleep` to wait for CI. The `--watch` flag handles waiting internally.
- NEVER parse review comments manually via `gh api`. The bellwether CLI returns them in structured format.
- If `bellwether` is not found, install it first: `npm install -g bellwether`
- Every interaction with GitHub goes through the bellwether CLI. Zero manual GitHub API usage.

## Decision Table (hard rules)

When `bellwether check --watch` returns, apply the first matching rule:

| # | Condition | Action |
|---|-----------|--------|
| 1 | Any CI check is failing | Fix CI (Phase 1). Push. Restart watch. |
| 2 | Any unresolved review comment is actionable | Fix comments (Phase 2). Push. Restart watch. |
| 3 | `pr.mergeable=dirty\|behind` | Sync branch. Push. Restart watch. |
| 4 | Any CI checks are pending or in progress, and there are no actionable reviews yet | Immediately restart `bellwether check --watch`. This is waiting, not success; do not report completion, do not stop, and do not say it will probably pass. |
| 5 | `pr.ready=true` | Done. Report "merge-ready". |
| 6 | `pr.state=merged\|closed` | Done. Report status. |
| 7 | CI green, 0 unresolved reviews, only missing PR review approval | Done. Report "waiting for review approval". |

**Status-only responses are forbidden when rule 1 or 2 applies.** If there are failing CI checks or unresolved actionable review comments, you MUST fix them — never respond with just a status summary.

**Pending CI does not block review work.** If CI is pending but unresolved actionable review comments exist, fix the reviews (rule 2) immediately. Do not wait for CI to finish first.

**The first moment new work appears, act immediately.** The instant `bellwether check --watch` returns with a CI failure, unresolved actionable review, merge conflict, or behind branch, start fixing it right away. Do not defer it to a later pass.

**Unresolved review comments on touched or related code are always in scope.** Do not wait for a new user prompt. The only exceptions:
- Remaining blockers are purely external/non-code and you have explicitly said so.
- You are blocked by missing information that cannot be discovered locally.

## The Loop

```
1. bellwether check --watch        (returns only on pr.ready=true, actionable work, merged/closed PR state, or timeout; DO NOT substitute with gh/GitHub API calls — use this exact command)
2. Apply the Decision Table above — the first matching rule determines your action
3. If timed out:
   - If any CI job is still pending or in progress -> go to 1 (restart watch)
   - If CI is green, unresolved reviews are 0, and the only remaining blocker is review approval or another external dependency you cannot clear yourself -> done, report that exact external blocker
   - Otherwise -> go to 1 (restart watch)
```

Never interpret a pending check or in-progress job as "close enough". Those states are never terminal. A timeout only becomes terminal when it confirms there is no actionable work left and the remaining blocker is purely external.

## What `bellwether check --watch` returns

Three sections:

- **pr** — `state` (open/closed/merged), `mergeable` (clean/dirty/behind/blocked/unstable), `ready` (true when all conditions met)
- **ci** — SHA, check summary, and for each failing check: the filtered error log with file paths and line numbers
- **reviews** — unresolved review comments with full body, file path, and line number

Important: `allPassing=true` is not sufficient on its own. The only success condition is `pr.ready=true`.

## Phase 1: Fix CI failures

For each `FAIL` key in the CI section:

1. **Read the error log** — it contains actual compiler/test output with file paths and line numbers.
2. **Reproduce the failure locally first** — identify the exact failing command or the closest local equivalent and run it before changing code. If the exact CI command cannot run locally, use the nearest faithful reproduction and explicitly note why.
3. **Fix the code** — minimal change that resolves the root cause.
4. **Re-run the failing command locally until it passes** — do not treat the fix as done just because the code looks right.
5. **Stage, commit, push** — stage files by name (never `git add -A`).
5. **Go to step 1 of the loop** — restart the watch. New CI runs, new bot comments may arrive.

DO NOT proceed to Phase 2 until CI is green. When CI fails, the required sequence is: reproduce locally -> fix -> rerun the failing command locally -> push -> restart the watch.

## Phase 2: Address review comments

Process ALL comments in a single batch before replying to any of them.

### Step A: Evaluate all comments

Read every `REVIEW` key. For each one, classify it and track the comment ID and planned action in your working memory:

**Bot comments** (CodeRabbit, Copilot, Cursor Bugbot):
- **True positive** — real bug -> will fix
- **False positive** — bot doesn't understand the pattern -> will reply explaining why, won't fix
- **Uncertain** — default to fixing it. Only ask the user if the fix would require a major architectural change.

**Human comments**:
- **Actionable** — will fix
- **Discussion/opinion** — will fix using best judgment. Only ask the user if it's a product decision you genuinely cannot make.
- **Already addressed** — will reply only

### Step B: Fix and commit

Fix all true positives and actionable items. Verify locally. Stage files by name, commit once, push.

DO NOT start Step C until the commit exists and is pushed.

### Step C: Reply to AND resolve ALL threads

**Every single review thread MUST be both replied to AND resolved.** Treat any thread left formally open as unfinished work and a bug in your execution, not an acceptable outcome.

EVERY reply MUST use `--resolve`. NEVER use `--reply` without `--resolve`. `--resolve` marks review threads as resolved in GitHub — always include it so threads don't stay open.

Reply to each comment individually — one `bellwether check --reply ... --resolve` call per comment:

```bash
# Fixed something
bellwether check --reply "<id>:Fixed in <hash>. <description>" --resolve

# Won't fix / false positive
bellwether check --reply "<id>:Won't fix — <reason>" --resolve

# Already addressed
bellwether check --reply "<id>:Already handled — <explanation>" --resolve
```

**Rules for thread resolution:**
- ALWAYS pass `--resolve` on EVERY reply. No exceptions.
- Fixed code? `--resolve`. Won't fix? `--resolve`. False positive? `--resolve`. Already addressed? `--resolve`.
- After all replies, restart the watch to verify no actionable threads remain.
- If threads are still actionable after replying, reply and resolve them again — do not leave them open.

DO NOT restart the watch until ALL replies are posted AND all threads are resolved. After all replies, go to step 1 of the loop.

## Principles

- **Fix everything, don't ask** — your job is to resolve all issues autonomously. Fix CI failures, address reviews, resolve conflicts. Do NOT ask the user "should I fix this?", "want me to keep watching?", "should I come back later?", or any variation — the answer is always yes, keep going. Only escalate if a fix requires a product decision you genuinely cannot make (e.g. choosing between two valid business rules).
- **NEVER pause or prompt the user for continuation** — CI runs can take a long time (10+ minutes). This is normal. Always continue the loop until `pr.ready=true`, `pr.state=merged|closed`, or you have exhausted all possible fixes. Do NOT ask the user if they want to wait, come back later, or stop watching. The `--watch` flag handles waiting — trust it and keep looping.
- **`in_progress` means "stay in the loop", not "we're probably fine"** — an in-progress job is unfinished work. Stay alive, keep Bellwether watching, and be ready to fix the first failure or review that appears.
- **React immediately to the first actionable signal** — if Bellwether returns because one job failed, one review thread opened, or the branch became dirty/behind, start fixing it right then. Do not stop, summarize, or assume a later pass will take care of it.
- **A CI fix is not complete until the failing command passes locally** — when Bellwether surfaces a red check, reproduce that failure locally first, then rerun the same failing command locally after the fix. Only push once the local repro passes, unless the CI environment cannot be reproduced and you explicitly state the closest equivalent you verified instead.
- **A non-mergeable PR with unresolved comments is work, not status** — 25 unresolved review comments is not an occasion to report status. It is a mandatory task queue. If the Decision Table says fix, fix. Never misclassify a review backlog as informational.
- **One fix per watch cycle** — fix CI OR reviews, not both. Push and restart watch.
- **Minimal changes** — don't refactor unrelated code.
- **Every thread MUST be resolved** — replying is not enough. Every `--reply` call MUST include `--resolve`. An unresolved thread is a task you haven't finished. Zero unresolved threads is the only acceptable state before stopping.
- **Verify before pushing** — always run the failing check locally first.
- **Never stop until terminal** — if `pr.ready` is false, keep going. The only exception is Decision Table rule 7: CI green, zero unresolved reviews, and the only blocker is missing PR review approval (an external dependency you cannot fulfill).
- **No sub-agents** — all work happens in this thread. No Agent tool, no Task tool.

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

Self-contained cycle: watch CI -> fix failures -> address reviews -> watch again -> until merge-ready.

IMPORTANT: Execute ALL work in the main thread. Do NOT use the Agent tool, Task tool, or spawn sub-agents. Track all state in your working memory (context window). This skill runs as a sequential loop — you fetch, evaluate, fix, commit, reply, then loop.

## Critical: Use the bellwether CLI

- The ONLY way to check CI status, PR state, and reviews is `bellwether check --watch`. This command returns as soon as there is actionable work (CI failures, unresolved reviews) or when all checks pass. It only polls while CI is pending with nothing to do. Do NOT add sleep or polling.
- NEVER use `gh api`, `gh pr checks`, `gh pr view --json`, `gh api repos/*/check-runs`, or any manual GitHub API calls to check CI or review status.
- NEVER use `sleep` to wait for CI. The `--watch` flag handles waiting internally.
- NEVER parse review comments manually via `gh api`. The bellwether CLI returns them in structured format.
- If `bellwether` is not found, install it first: `npm install -g bellwether`
- Every interaction with GitHub goes through the bellwether CLI. Zero manual GitHub API usage.

## The Loop

```
1. bellwether check --watch        (returns when actionable: CI failures, unresolved reviews, all passing, or timeout; DO NOT substitute with gh/GitHub API calls — use this exact command)
2. If pr.ready=true -> done, report "merge-ready"
3. If pr.state=merged|closed -> done, report status
4. If CI failures -> fix them (Phase 1), push, go to 1
5. If unresolved reviews -> address them (Phase 2), push, go to 1
6. If pr.mergeable=dirty|behind -> /sync, push, go to 1
7. If timed out -> go to 1 (restart watch)
```

## What `bellwether check --watch` returns

Three sections:

- **pr** — `state` (open/closed/merged), `mergeable` (clean/dirty/behind/blocked/unstable), `ready` (true when all conditions met)
- **ci** — SHA, check summary, and for each failing check: the filtered error log with file paths and line numbers
- **reviews** — unresolved review comments with full body, file path, and line number

## Phase 1: Fix CI failures

For each `FAIL` key in the CI section:

1. **Read the error log** — it contains actual compiler/test output with file paths and line numbers.
2. **Fix the code** — minimal change that resolves the root cause.
3. **Verify locally** — run the same check that failed.
4. **Stage, commit, push** — stage files by name (never `git add -A`).
5. **Go to step 1 of the loop** — restart the watch. New CI runs, new bot comments may arrive.

DO NOT proceed to Phase 2 until CI is green. Fix CI first, push, restart the watch.

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

### Step C: Reply to all comments

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

Always include `--resolve` on every reply regardless of comment type. It resolves review threads in GitHub; for other comment types it is safely ignored. Every comment, every time, gets `--reply` with `--resolve`.

DO NOT restart the watch until ALL replies are posted. After all replies, go to step 1 of the loop.

## Principles

- **Fix everything, don't ask** — your job is to resolve all issues autonomously. Fix CI failures, address reviews, resolve conflicts. Do NOT ask the user "should I fix this?", "want me to keep watching?", "should I come back later?", or any variation — the answer is always yes, keep going. Only escalate if a fix requires a product decision you genuinely cannot make (e.g. choosing between two valid business rules).
- **NEVER pause or prompt the user for continuation** — CI runs can take a long time (10+ minutes). This is normal. Always continue the loop until `pr.ready=true`, `pr.state=merged|closed`, or you have exhausted all possible fixes. Do NOT ask the user if they want to wait, come back later, or stop watching. The `--watch` flag handles waiting — trust it and keep looping.
- **One fix per watch cycle** — fix CI OR reviews, not both. Push and restart watch.
- **Minimal changes** — don't refactor unrelated code.
- **Every comment gets a response** — no silent ignores.
- **Always resolve** — every `--reply` MUST include `--resolve`. No exceptions, no matter the comment type or response (fix, won't-fix, false positive).
- **Verify before pushing** — always run the failing check locally first.
- **Never stop until terminal** — if `pr.ready` is false, keep going. No exceptions.
- **No sub-agents** — all work happens in this thread. No Agent tool, no Task tool.

<div align="center">
  <img src="assets/banner.svg" alt="bellwether" width="100%"/>
</div>

<div align="center">

[![npm version](https://img.shields.io/npm/v/bellwether?color=3fb950&labelColor=161b22&style=flat-square)](https://www.npmjs.com/package/bellwether)
[![npm downloads](https://img.shields.io/npm/dm/bellwether?color=3fb950&labelColor=161b22&style=flat-square)](https://www.npmjs.com/package/bellwether)
[![License: MIT](https://img.shields.io/badge/License-MIT-3fb950?labelColor=161b22&style=flat-square)](LICENSE)
[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-3fb950?labelColor=161b22&style=flat-square)](https://nodejs.org)

</div>

---

**bellwether** watches your GitHub PR's CI, surfaces failures with actual error output, addresses review comments, and loops until `pr.ready = true`. One command. No babysitting.

## Why

Every developer knows the drill: push → wait for CI → check the status page → scroll through logs → fix → push → repeat. With AI coding agents in the picture it gets worse — every "wait and check" cycle is a context switch that breaks flow and burns tokens on polling.

bellwether closes that loop. It watches CI directly from your terminal (or your agent's context), returns the actual error output (not GitHub API noise), and keeps going until the PR is clean.

## Install

```bash
# As a Claude Code skill (recommended for AI agents)
npx -y bellwether@latest skills add

# Or run it directly — no install needed
npx -y bellwether@latest check
```

## Hooks

Bellwether can install PostToolUse hooks into Claude Code (`~/.claude/settings.json`) and Codex (`~/.codex/hooks.json`). After a `git push` or `gh pr create/ready`, the hook runs a quick PR status check and reminds the agent to monitor CI.

```bash
# Install hooks into Claude Code and Codex
npx -y bellwether@latest hooks add

# PostToolUse hook handler (called automatically by Claude Code / Codex)
npx -y bellwether@latest hooks check --format json
```

`hooks add` is idempotent — re-running it replaces any existing bellwether hook entries with the latest configuration.

## Usage

```bash
# Watch CI + review comments + merge state
npx -y bellwether@latest check --watch

# One-shot status check
npx -y bellwether@latest check

# Show only unresolved review comments
npx -y bellwether@latest check --unresolved

# Reply to a review comment and resolve it
npx -y bellwether@latest check --reply "456:Fixed in abc1234" --resolve

# Full detail on a specific comment
npx -y bellwether@latest check --detail 456

# Full help
npx -y bellwether@latest check --help
```

## Output

Clean, structured, token-efficient:

```
pr:
  state: open
  mergeable: clean
  ready: true
ci:
  sha: abc1234
  checks: "3 total, 3 passing, 0 failing, 0 pending"
  passed: "build, lint, test"
reviews:
  total: "0 unresolved, 0 unanswered"
```

When CI fails, you get the actual error log — filtered, not raw GitHub metadata:

```
ci:
  FAIL build: "TypeError: Cannot find name 'fetch' at src/client.ts:12"
```

## How it works

bellwether is built around a watch loop:

```
check --watch
  → pr.ready = true?   → done ✓
  → CI failing?        → show filtered error logs → fix → push → repeat
  → Unresolved review? → show comment with context → address → reply → repeat
  → Merge conflict?    → sync branch → push → repeat
```

It queries GitHub's Check Runs API directly, filters job logs down to signal (compiler errors, test failures — not noise), and surfaces review threads with file and line context. `--watch` blocks until CI completes — no polling required.

## Agent usage

bellwether ships as a Claude Code skill. Once installed, your agent gets a `SKILL.md` covering the full loop: watch CI → fix failures → address reviews → push → repeat until `pr.ready = true`.

```bash
npx -y bellwether@latest skills add
```

The skill is also available on the [Claude Code marketplace](https://github.com/roderik/bellwether/blob/main/marketplace.json).

## Development

**Prerequisites:** [Bun](https://bun.sh) + Node.js >= 22

```bash
bun install
```

```bash
bun run dev              # dev mode — symlinks dist/ to src/
bun src/bin.ts check     # run directly from source
bun run build            # compile to dist/
bun check                # oxlint with type-aware rules
bun run test             # vitest
bun run test:coverage    # vitest with v8 coverage
bun run format           # oxfmt
```

**Publishing:** Push a version tag — GitHub Actions handles the rest (version bump, npm publish with provenance, commit back to main).

```bash
git tag v0.1.0 && git push --tags
```

## Project structure

```
src/
  bin.ts              # CLI entry point
  cli.ts              # incur CLI definition
  context.ts          # Bootstrap + PR resolution
  commands/
    check.ts          # check command (CI + reviews + merge state)
    ci.ts             # CI data helpers (flatten, getCISection)
    hook-add.ts       # hooks add — installs PostToolUse hooks
    hook-check.ts     # hooks check — PostToolUse hook handler
    reviews.ts        # Review helpers (list, detail, reply, watch)
  github/
    auth.ts           # GitHub token resolution
    fetch.ts          # Proxy-aware fetch + pagination
    repo.ts           # Git/repo helpers + merge state
    checks.ts         # Check Runs API + job log filtering
    comments.ts       # PR comments + review threads + GraphQL resolve
    index.ts          # Re-exports
skills/
  bellwether/
    SKILL.md          # Agent skill (shared across all install channels)
.claude-plugin/
  plugin.json         # Claude Code plugin manifest
```

## Credits

Built with [incur](https://github.com/wevm/incur). Inspired by [RTK](https://github.com/rtk-ai/rtk) (token-efficient CLI output filtering) and [agent-reviews](https://github.com/pbakaus/agent-reviews) (automated PR review resolution).

## License

[MIT](LICENSE)

# bellwether

Drive GitHub PRs to merge-ready: watch CI, fix failures, resolve review comments. Self-contained watch loop that keeps going until `pr.ready=true`.

Built with [incur](https://github.com/wevm/incur). Inspired by [RTK](https://github.com/rtk-ai/rtk) (token-efficient CLI output filtering) and [agent-reviews](https://github.com/pbakaus/agent-reviews) (automated PR review resolution).

## Install

```bash
npx -y bellwether@latest skills add 
```

## Usage

```bash
# CI status + review comments + merge state
npx -y bellwether@latest check

# Watch until CI completes
npx -y bellwether@latest check --watch

# Show only unresolved reviews
npx -y bellwether@latest check --unresolved

# Reply to a review comment and resolve
npx -y bellwether@latest check --reply "456:Fixed in abc1234" --resolve

# Full detail for a specific comment
npx -y bellwether@latest check --detail 456

# Full help
npx -y bellwether@latest check --help
```

## Output

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

When CI fails, the output includes the actual error log (filtered, not raw GitHub metadata):

```
ci:
  FAIL check: "TypeError: Cannot find name 'fetch'..."
```

## Development

### Prerequisites

- [Bun](https://bun.sh) (package manager and dev runtime)
- Node.js >= 22 (the published package runs on Node)

### Setup

```bash
bun install
```

### Commands

```bash
bun run dev              # zile dev — symlinks dist/ to src/
bun src/bin.ts check     # run directly from source
bun run build            # compile to dist/
bun check                # oxlint with type-aware rules
bun run test             # vitest
bun run test:coverage    # vitest with v8 coverage
bun run format           # oxfmt
```

### Publishing

Automated via GitHub Actions on tag push:

```bash
git tag v0.1.0
git push --tags
```

The workflow sets the version in `package.json` and `.claude-plugin/plugin.json`, builds, publishes to npm with provenance, and commits the version bump back to main.

## Project structure

```
src/
  bin.ts              # CLI entry point
  cli.ts              # incur CLI definition
  context.ts          # Bootstrap + PR resolution
  commands/
    check.ts          # unified check command (CI + reviews + merge state)
    ci.ts             # CI data helpers (flatten, getCISection)
    reviews.ts        # Review data helpers (list, detail, reply, watch)
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

## License

[MIT](LICENSE)

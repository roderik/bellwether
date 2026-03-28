# sheperd

Monitor GitHub PRs — review comments and CI status. Built with [incur](https://github.com/wevm/incur).

## Install

```bash
npm install -g sheperd
```

## Usage

```bash
# List review comments for the current branch's PR
sheperd reviews

# Show CI status
sheperd ci

# Watch CI until all checks complete
sheperd ci --watch

# Show unresolved bot comments
sheperd reviews --unresolved --bots-only

# Reply to a comment
sheperd reviews --reply "12345:Fixed in latest commit"

# Full help
sheperd --help
```

## Development

### Prerequisites

- [Bun](https://bun.sh) (used as package manager and dev runtime)
- Node.js >= 18 (the published package runs on Node)

### Setup

```bash
bun install
```

### Dev mode

```bash
bun run dev
```

This runs `zile dev`, which creates symlinks from `dist/` back to `src/`. The `bin` field in `package.json` points to `dist/bin.js`, so after running dev mode you can link the package and the `sheperd` command resolves directly to your TypeScript source:

```bash
bun link          # registers the package locally
sheperd reviews   # runs your source via the dist/ symlinks
```

Changes to source files take effect immediately — no rebuild needed.

### Running directly

During development you can also skip linking and run the source entry point:

```bash
bun src/bin.ts reviews
bun src/bin.ts ci --watch
```

### Build

```bash
bun run build
```

Compiles TypeScript to `dist/` via [zile](https://github.com/wevm/zile) (tsc wrapper). Output is standard ESM that runs on Node.js without Bun.

### Lint

```bash
bun check
```

Runs [oxlint](https://oxc.rs) with type-aware rules.

### Format

```bash
bun run format
```

Runs [oxfmt](https://oxc.rs).

## Publishing

Publishing is automated via GitHub Actions. To release:

```bash
git tag v0.1.0
git push --tags
```

The workflow sets the `package.json` version from the tag, builds with `zile publish:prepare`, and publishes to npm with provenance.

Requires an `NPM_TOKEN` repository secret.

## Project structure

```
src/
  bin.ts              # CLI entry point (#!/usr/bin/env node)
  cli.ts              # incur CLI definition, middleware, commands
  context.ts          # Bootstrap (token, repo info) and PR resolution
  commands/
    ci.ts             # `sheperd ci` — CI/check run status
    reviews.ts        # `sheperd reviews` — review comments
  github/
    auth.ts           # GitHub token resolution
    fetch.ts          # Proxy-aware fetch + pagination
    repo.ts           # Git/repo helpers
    checks.ts         # GitHub Check Runs API
    comments.ts       # GitHub PR comments + review threads
    index.ts          # Re-exports
dist/                 # Build output (gitignored)
```

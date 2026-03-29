# Contributing to bellwether

## Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [Bun](https://bun.sh/) (latest)
- A GitHub token with `repo` scope for integration tests

## Setup

```sh
git clone https://github.com/roderik/bellwether.git
cd bellwether
bun install
```

## Development workflow

```sh
bun run test          # run tests once
bun run test:coverage # run tests with v8 coverage report
bun run lint          # oxlint — must produce 0 warnings
bun run build         # compile to dist/
```

All checks run automatically on every push and PR via the CI workflow.

## Submitting a PR

1. Fork the repo and create a branch from `main`.
2. Make your changes. Add or update tests as needed.
3. Run `bun run lint` and `bun run test:coverage` — both must pass cleanly.
4. Open a PR against `main`. The CI pipeline will verify:
   - `oxlint` with zero warnings
   - Vitest test suite with coverage
   - TypeScript build succeeds

## Commit messages

Use plain imperative sentences: `Add --watch flag`, `Fix CI timeout handling`, `Update README`.

## Releasing

Releases are triggered by pushing a git tag:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The `publish.yml` workflow sets the version in `package.json` and `.claude-plugin/plugin.json`, builds, and publishes to npm with provenance.

## Code style

Formatting is enforced by `oxfmt`. Linting uses `oxlint` in strict mode (all categories set to error, zero warnings). TypeScript strict mode is enabled.

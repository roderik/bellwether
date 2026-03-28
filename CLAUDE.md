# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is this?

bellwether is a CLI tool that monitors GitHub PRs — review comments and CI status. Built with [incur](https://github.com/wevm/incur) (a framework for CLIs that work for both AI agents and humans) and [@clack/prompts](https://github.com/bombshell-dev/clack) for interactive UI.

## Commands

- `bun install` — install dependencies
- `bun check` — lint with oxlint (type-aware)
- `bun run format` — format with oxfmt
- `bun test` — run tests (vitest)
- `bun test:coverage` — run tests with 100% coverage enforcement
- `bun run build` — build with zile (tsc wrapper)
- `bun run dev` — dev mode with zile (symlink-based)

## Testing

Tests live in `test/` mirroring the `src/` structure. 100% coverage is enforced on lines, functions, branches, and statements. Coverage excludes `src/bin.ts`, `src/cli.ts`, and `src/github/index.ts` (entry points and re-exports).

Run a single test file: `bunx vitest run test/path/to/file.test.ts`

## Code Style

- TypeScript ESM with `"type": "module"` — use `import`/`export`, not `require`
- `NodeNext` module resolution — file extensions required in imports (`.js` for `.ts` files)
- Formatting is handled by oxfmt, linting by oxlint — do not add eslint or prettier
- Use `incur` patterns for CLI commands (see existing commands in `src/commands/`)

## Publishing

Tag-triggered via GitHub Actions: `git tag v0.1.0 && git push --tags`. Version is auto-set from the tag. Preview packages are published on PRs via pkg-pr-new.

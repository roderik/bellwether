---
name: verify
description: Run lint, tests, and build to verify the project is in a good state. Use after making code changes.
allowed-tools: Bash(bun *) Read
---

Run all verification steps sequentially. Stop and report on first failure:

1. `bun check` — oxlint with type-aware checking
2. `bun test` — vitest with 100% coverage enforcement
3. `bun run build` — zile build (tsc)

Report a summary of results when done.

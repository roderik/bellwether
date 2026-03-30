# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.7] - 2026-03-30

### Added

- Added PR branch syncing so `bellwether check` can update branches that are behind their base branch before continuing.
- Added merge conflict detection and resolution guidance when a PR cannot be auto-synced cleanly.
- Added [`CONTRIBUTING.md`](./CONTRIBUTING.md) with local development and pull request workflow guidance.

### Changed

- Renamed the hook commands from `hook-add` and `hook-check` to the grouped `hooks add` and `hooks check` subcommands.
- Reworked the README with clearer positioning, updated visuals, and sync-driven workflow documentation.

## [0.0.6] - 2026-03-28

### Changed

- Published a follow-up release of the hook command registration work from the earlier `v0.0.5` cut.
- Kept the CLI version sourced from `package.json` so the published binary and docs report the same release number.

## [0.0.5] - 2026-03-28

### Added

- Added dedicated hook installation and validation commands for Claude Code and Codex integrations.

### Changed

- Switched CLI version reporting to read directly from `package.json`.

## [0.0.4] - 2026-03-28

### Fixed

- Fixed the sync working directory used during skill installation so `npx` installs include the packaged `SKILL.md` content correctly.

## [0.0.3] - 2026-03-28

### Fixed

- Added the missing `pull-requests:write` permission needed for PR maintenance operations.
- Fixed module detection in the CLI entrypoint.
- Set the sync depth to `0` so skill installs land as `bellwether` with the expected `SKILL.md` content.

## [0.0.2] - 2026-03-28

### Added

- Initial public release of `bellwether`.
- Added the Node.js-based CLI, build pipeline, and GitHub Actions workflows used to check and package the project.
- Added Renovate configuration for dependency maintenance.

### Changed

- Updated the core GitHub Actions dependencies to `actions/checkout@v6` and `actions/setup-node@v6`.

[Unreleased]: https://github.com/roderik/bellwether/compare/v0.0.7...HEAD
[0.0.7]: https://github.com/roderik/bellwether/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/roderik/bellwether/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/roderik/bellwether/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/roderik/bellwether/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/roderik/bellwether/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/roderik/bellwether/releases/tag/v0.0.2

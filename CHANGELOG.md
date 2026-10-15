# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/) (while the version is `0.x`, a minor bump can break compatibility).

## [Unreleased]

### Added

- `createBashJobs({ createBashTool, killWaitMs })` builds the extension with an injected bash tool definition and kill wait; the default export uses pi's bash tool. Tests use it to simulate processes that do not exit or fail to spawn.
- Tests for the `/jobs` command, user kills, the footer status, `session_start`, startup errors and concurrent jobs. Tests wait on events or poll with a deadline instead of sleeping a fixed time.
- `reason` in the completion message details (`exit`, `timeout`, `aborted`, `error`). A timeout reads `timed out after … (timeout Ns)` instead of `failed`.
- The completion message format is documented in the README.

### Fixed

- A multi-line command with blank lines no longer shows part of the command as output in the completion row. The header, the `/jobs` list and the `job` result show a one-line summary of the command; `details.command` keeps the full command.
- Durations carry over rounded seconds and show hours (`59.96s` is `1m0s`, not `60.0s`; `2h0m0s`, not `120m0s`).
- Jobs that time out or are killed after their output was truncated keep the truncation details, so the completion row shows the full output path and the truncation warning.

## [0.2.0] - 2026-10-14

### Changed

- **Breaking:** renamed the tools `bash_job` and `bash_job_kill` to `job` and `kill_job`, and the command `/bash-jobs` to `/jobs`. Update permission rules, tool allowlists (`--tools`) and prompts that name the old tools.
- The job completion is drawn as a finished `bash` tool row (`$ command · job-1`, output preview, `Took Ns`) instead of a separate notification. The rows are titled `Job` and `Kill Job`.

### Added

- CI on Linux and Windows (typecheck and tests).
- `engines.node` and a Compatibility section in the README (pi 1.1.0 or later).

## [0.1.0] - 2026-10-10

### Added

- `bash_job` and `bash_job_kill` tools that run commands through pi's built-in bash tool in the background and steer the completion into the conversation.
- `/bash-jobs` command to list and kill jobs, and a footer status while jobs run.

[Unreleased]: https://github.com/k4zunoko/pi-bash-jobs/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/k4zunoko/pi-bash-jobs/compare/cb7356c...v0.2.0
[0.1.0]: https://github.com/k4zunoko/pi-bash-jobs/commit/cb7356c

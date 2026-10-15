# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/) (while the version is `0.x`, a minor bump can break compatibility).

## [Unreleased]

### Changed

- The README is rewritten as a user guide (quick start, how it works, usage examples, security, FAQ). The full reference (tool errors, completion message fields, rendering, kills, exported API) moved to [docs/reference.md](docs/reference.md), and development, tests and the release steps to [CONTRIBUTING.md](CONTRIBUTING.md).

## [0.3.0] - 2026-10-15

### Added

- `createBashJobs({ createBashTool, killWaitMs })` builds the extension with an injected bash tool definition and kill wait; the default export uses pi's bash tool. Tests use it to simulate processes that do not exit or fail to spawn.
- Tests for the `/jobs` command, user kills, the footer status, `session_start`, startup errors and concurrent jobs. Tests wait on events or poll with a deadline instead of sleeping a fixed time.
- End-to-end tests with a real pi session runtime and a faux model (`test/e2e-harness.ts`).
- `reason` in the completion message details (`exit`, `timeout`, `aborted`, `error`, `interrupted`). A timeout reads `timed out after … (timeout Ns)` instead of `failed`.
- The completion message format is documented in the README.
- `job` and `kill_job` declare an `outputSchema` and return `structuredContent` (`{ id, command }` and `{ id, exited, status, exit_code?, output }`), so codemode scripts get data instead of text.
- Prompt guidelines: end the turn when nothing else is left to do while a job runs, and do not rerun a job's command with `bash`.
- `job` and `kill_job` declare tool annotations (`job`: destructive, open world; `kill_job`: not destructive, idempotent, closed world) for permission extensions.
- A Security section in the README: how jobs relate to extensions that replace `bash` (detected, `job` refuses) and to `tool_call` guards on `bash` (not detectable; how to extend them to `job` or disable the job tools).
- `jobs { id?, tail? }`: a read-only tool that lists the running jobs, or shows the last lines of one job's output so far, so the agent can tell a stuck job from a slow one.
- `/jobs show <id> [lines]` (alias `tail`) shows a running job's latest output; `/jobs kill` accepts several ids and warns about unknown ones; completion offers `list`, `show <id>`, `kill <id>`, and `kill all` only when jobs run.

### Changed

- `job` checks the `timeout` (same rules as the bash tool) and the working directory before it starts, and returns an error result instead of starting a job that fails right away. No job id is used up.
- Jobs use the `shellPath` and `shellCommandPrefix` settings like the built-in `bash` tool (read with `pi.getSettings()` when each job starts). A `shellPath` that does not exist is an error result. Without `pi.getSettings()` (older pi), jobs keep using pi's default shell.
- **Breaking for setups that replace `bash`:** `job` refuses to start while an extension replaces the `bash` tool (sandbox, SSH, spawn hook), because the job would run locally with pi's built-in bash and bypass it. The error result names the extension and tells the model to use `bash`; the user gets a warning when the session starts.

### Fixed

- A multi-line command with blank lines no longer shows part of the command as output in the completion row. The header, the `/jobs` list and the `job` result show a one-line summary of the command; `details.command` keeps the full command.
- Durations carry over rounded seconds and show hours (`59.96s` is `1m0s`, not `60.0s`; `2h0m0s`, not `120m0s`).
- Jobs that time out or are killed after their output was truncated keep the truncation details, so the completion row shows the full output path and the truncation warning.
- A job that does not exit within the 5s kill wait is no longer lost: it is listed and counted as `killing` (`/jobs`, footer), and its output is recorded in the conversation (without waking the agent) when it exits. `kill_job` returns an error result with `details.exited: false` in that case, and `details.exited`, `status`, `reason` and `exitCode` otherwise. `/jobs kill` reports `Killed` only for jobs that exited and warns about the others.
- Quitting, `/reload` and switching sessions no longer drop running jobs silently: each one is killed, pi waits up to 5s in total for them to exit, and the conversation of the session that ran it gets one `interrupted` message with the output so far. A model that resumes the conversation no longer waits for a result that never comes.
- Job ids continue after the highest id in the branch when a new runtime starts (reload, resume), so ids are not reused within a conversation.
- A failing completion message (for example from a stale runtime) no longer causes an unhandled promise rejection.
- Print and JSON mode (`pi -p`, `pi --mode json`) no longer drop job results: when the model ends its turn while jobs run, the run waits at `agent_before_settle` until they finish, so the results reach the model before pi exits.

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

[Unreleased]: https://github.com/k4zunoko/pi-bash-jobs/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/k4zunoko/pi-bash-jobs/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/k4zunoko/pi-bash-jobs/compare/cb7356c...v0.2.0
[0.1.0]: https://github.com/k4zunoko/pi-bash-jobs/commit/cb7356c

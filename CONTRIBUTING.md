# Contributing to pi-bash-jobs

Thanks for helping. Bug reports and ideas go to [issues](https://github.com/k4zunoko/pi-bash-jobs/issues); code and documentation changes come as pull requests against `main`.

## Contents

- [Requirements](#requirements)
- [Set up](#set-up)
- [Run your changes in pi](#run-your-changes-in-pi)
- [Tests](#tests)
- [CI](#ci)
- [Pull requests](#pull-requests)
- [Releasing](#releasing)

## Requirements

- **Node 22.19 or later.** `npm test` runs the `.ts` files directly with Node's built-in type stripping (on by default since Node 22.18; pi itself requires 22.19).
- **bash.** Some tests run real commands through pi's bash tool: `/bin/bash` on Linux and macOS, Git Bash on Windows (found the same way pi finds it).

## Set up

```bash
npm install        # dev dependencies only, for types and tests
npm run typecheck
npm test
```

At runtime, pi maps `@earendil-works/*` and `typebox` imports to its own copies, so they are peer dependencies with a `"*"` range (see [Compatibility](README.md#compatibility)). The dev dependencies pin the versions the types and tests use.

## Run your changes in pi

```bash
pi -ne -e ./src/index.ts
```

`-ne` (`--no-extensions`) turns off discovered, configured and built-in extensions, so an installed copy of this package does not register the same tools twice. Explicit `-e` paths still load.

## Tests

| File | Covers |
|---|---|
| `test/bash-jobs.test.ts` | Integration with pi's real bash tool |
| `test/job-control.test.ts` | Job control with a fake bash tool: kills that are ignored, spawn failures, jobs finishing in a chosen order |
| `test/kill.test.ts` | Kills that wait for the exit, and kills whose wait times out |
| `test/jobs-tool.test.ts` | The read-only `jobs` tool |
| `test/jobs-command.test.ts` | The `/jobs` command: listing, killing, usage and argument completions |
| `test/format.test.ts` | The completion message format: durations, command summary, end reasons, truncation, old messages |
| `test/validation.test.ts` | Validation before a job starts, and structured results |
| `test/shell-settings.test.ts` | `shellPath` and `shellCommandPrefix` |
| `test/security.test.ts` | Refusing jobs when `bash` is replaced, annotations, a `tool_call` guard extended to `job` |
| `test/lifecycle.test.ts` | Job ids across runtimes, the bounded shutdown wait, report failures |
| `test/print-mode.test.ts` | Print and JSON mode waiting at `agent_before_settle` |
| `test/status-event.test.ts` | The `bash-jobs:status` event, also through a real pi runtime in interactive mode |
| `test/session.e2e.test.ts` | Reload, quit and resume, and session replacement through a real pi runtime |
| `test/print.e2e.test.ts` | Print and RPC mode through a real pi runtime |

Two harnesses support them:

- **`test/helpers.ts`** provides a fake `ExtensionAPI` that records messages and UI calls, and `fakeBash()`, a bash tool whose runs stay pending until the test resolves or rejects them. Pass it as `createBashJobs({ createBashTool })` to test paths a real process cannot reproduce on demand (a process that ignores the kill, a spawn failure, jobs finishing in a chosen order).
- **`test/e2e-harness.ts`** runs a real pi session runtime (`createAgentSessionRuntime`) with the extension and a scripted faux model (`@earendil-works/pi-ai`), for behavior that depends on pi itself: reload, quit and resume, session replacement.

Conventions that keep the tests fast and reliable on every platform:

- Wait for messages, or poll with a deadline (`waitFor`), instead of sleeping a fixed time.
- Commands that get killed loop with shell builtins, so no child process (such as `sleep.exe` under Git Bash) outlives the kill.

## CI

[CI](.github/workflows/ci.yml) runs the typecheck and the tests on Linux and Windows (Git Bash) with Node 22, for every pull request and every push to `main`.

## Pull requests

- Open pull requests against `main`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) as in the history (`feat:`, `fix:`, `docs:`, `test:`, `chore:`; `feat!:` for breaking changes).
- Add user-visible changes under `Unreleased` in [CHANGELOG.md](CHANGELOG.md), and mark breaking ones.
- Update the [README](README.md) or the [reference](docs/reference.md) when behavior changes. The completion message format is a public contract: see its [compatibility rules](docs/reference.md#compatibility).

## Releasing

1. Move the `Unreleased` entries in [CHANGELOG.md](CHANGELOG.md) under a new version heading with the date, and set the same `version` in `package.json` (`npm version <x.y.z> --no-git-tag-version` also updates `package-lock.json`). While the version is `0.x`, bump the minor version for breaking changes.
2. Merge that change into `main`, then tag the merge commit and push the tag: `git tag v<x.y.z> && git push origin v<x.y.z>`.
3. Create a GitHub Release for the tag with the CHANGELOG section as its notes (`gh release create v<x.y.z> --notes-file <file>`).

# pi-bash-jobs

A small [pi](https://pi.dev) extension that runs bash commands as background jobs and interrupts the agent when they finish.

Start a build or test run, keep working on something else, and get the result as soon as it is done.

## Design

- **Execution is pi's own bash tool.** Jobs run through `createBashToolDefinition().execute()`, so shell resolution (Git Bash on Windows), `PI_*` environment variables, `timeout`, process-tree kill, output truncation (last 2000 lines / 50KB) and the full-output temp file behave exactly like the built-in `bash` tool.
- **Completion is a steer message.** `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })` interrupts a running agent after its current tool batch, or starts a new turn when pi is idle.
- **Completion is drawn as a bash tool row.** The message renderer returns pi's own `ToolExecutionComponent` for `bash` with the bash tool's renderers, so it looks like a finished `bash` call (`$ command · job-1`, output preview, `Took Ns`, ctrl+o to expand). The row is labeled `Job` (the `job` start row too, and `Kill Job` for `kill_job`), which display extensions use as its title. Display extensions that restyle bash rows by patching `ToolExecutionComponent` apply to it too. Renderers registered with `pi.registerToolRenderer` for `bash` are not consulted, because extensions cannot query that chain.
- **No interactive shell, no PTY, no persistence.** Jobs live as long as the session.

## Tools

| Tool | Description |
|---|---|
| `job { command, timeout? }` | Start a background job and return its id (`job-1`, ...) immediately. |
| `kill_job { id }` | Kill a running job and its child processes; returns the output so far. |

A job killed by the agent is reported only in the `kill_job` result (no extra message).

## Command

| Command | Description |
|---|---|
| `/jobs` | List running jobs. |
| `/jobs kill <id>` / `/jobs kill all` | Kill jobs. The kill is recorded in the conversation without waking the agent. |

The footer shows `jobs: N running` while jobs are active.

## Install

```bash
pi install git:github.com/k4zunoko/pi-bash-jobs
```

Update with `pi update git:github.com/k4zunoko/pi-bash-jobs`. For development, run `pi -ne -e ./src/index.ts` from a clone so the installed copy does not register the same tools twice.

To pin a release, install a tag. Updates then keep that version until you install another tag:

```bash
pi install git:github.com/k4zunoko/pi-bash-jobs@v0.2.0
```

Releases and breaking changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Compatibility

- **pi 1.1.0 or later.** The completion row uses the `outputPad` and `durationMs` render options added in pi 1.1.0, and the exit code comes from the bash tool's `structuredContent` (pi 0.99.0). Older versions are not tested.
- The pi packages and `typebox` are `peerDependencies` with a `"*"` range, as pi's [package docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md#declare-dependencies) require: pi provides its own copies at runtime and installs packages without peer resolution, so a version range there would not be checked. The minimum version is stated here instead.
- `engines.node` (`>=22.19.0`) matches pi's own requirement. Development needs it too, because the tests run the `.ts` sources directly with Node's type stripping.

## Limitations

- Meant for commands that finish on their own (builds, tests). Servers and watchers never complete, so they never notify.
- All jobs are killed silently when the session shuts down, reloads, or is replaced.
- Extensions that guard the tool named `bash` (permission gates, confirmations) do not see `job`; add it to them if needed.
- The settings `shellPath` is not read; the default shell resolution of pi is used.
- On Windows with Git Bash, killing a job can leave its child processes running (for example `sleep.exe`). MSYS starts children through intermediate processes that exit, so pi's `taskkill /T` cannot reach them. The built-in bash tool shares this behavior when aborted. Jobs that run to completion are not affected.

## Development

```bash
npm install      # dev dependencies only, for types and tests
npm run typecheck
npm test
pi -ne -e ./src/index.ts
```

At runtime pi maps `@earendil-works/*` and `typebox` imports to its own copies, so they are peer dependencies.

CI runs the typecheck and the tests on Linux and Windows (Git Bash) for every pull request and push to `main`.

### Releasing

1. Move the `Unreleased` entries in [CHANGELOG.md](CHANGELOG.md) under a new version heading with the date, and set the same `version` in `package.json` (`npm version <x.y.z> --no-git-tag-version` also updates `package-lock.json`). While the version is `0.x`, bump the minor version for breaking changes.
2. Merge that change into `main`, then tag the merge commit and push the tag: `git tag v<x.y.z> && git push origin v<x.y.z>`.
3. Create a GitHub Release for the tag with the CHANGELOG section as its notes (`gh release create v<x.y.z> --notes-file <file>`).

# pi-bash-jobs

A small [pi](https://pi.dev) extension that runs bash commands as background jobs and interrupts the agent when they finish.

Start a build or test run, keep working on something else, and get the result as soon as it is done.

## Design

- **Execution is pi's own bash tool.** Each job runs through `createBashToolDefinition(cwd, { shellPath, commandPrefix })`, created with the `shellPath` and `shellCommandPrefix` settings the way pi creates the built-in `bash` tool. Shell resolution (Git Bash on Windows, or `shellPath`), the command prefix, `PI_*` environment variables, `timeout`, process-tree kill, output truncation (last 2000 lines / 50KB) and the full-output temp file behave like the built-in `bash` tool. Differences: a job reads the settings when it starts, while the built-in tool reads them when the session starts or reloads; and extensions that guard or replace `bash` do not apply to jobs (see [Security](#security)).
- **Completion is a steer message.** `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })` interrupts a running agent after its current tool batch, or starts a new turn when pi is idle.
- **Completion is drawn as a bash tool row.** The message renderer returns pi's own `ToolExecutionComponent` for `bash` with the bash tool's renderers, so it looks like a finished `bash` call (`$ command · job-1`, output preview, `Took Ns`, ctrl+o to expand). The row is labeled `Job` (the `job` start row too, and `Kill Job` for `kill_job`), which display extensions use as its title. Display extensions that restyle bash rows by patching `ToolExecutionComponent` apply to it too. Renderers registered with `pi.registerToolRenderer` for `bash` are not consulted, because extensions cannot query that chain.
- **No interactive shell, no PTY, no persistence.** Jobs live as long as the session runtime. When it ends (quit, `/reload`, or switching to a new, resumed or forked session), running jobs are killed and each one is recorded in the conversation of the session that ran it (see [Session end](#session-end)).

## Tools

| Tool | Description | Structured result (`structuredContent`) |
|---|---|---|
| `job { command, timeout? }` | Start a background job and return its id (`job-1`, ...) immediately. An invalid `timeout` (not a positive number, or over 2147483.647 seconds) or a missing working directory is an error result, and no job starts. | `{ id, command }` |
| `kill_job { id }` | Kill a running job and its child processes, wait up to 5s for it to exit, and return its output so far. | `{ id, exited, status, exit_code?, output }`; `status` is `done`, `failed`, `killed`, or `killing` (not exited yet) |
| `jobs { id?, tail? }` | Read-only. List the running jobs (id, elapsed time, `killing` state, command), or with `id` also show the last `tail` lines (default 20, at most 500) of that job's output so far, and the full output file once the output is truncated. | `{ jobs: [{ id, command, state, elapsed_seconds, timeout? }], output? }` |

The model reads the text result; programmatic callers such as codemode scripts receive the structured result, which the tools declare with `outputSchema`.

A job killed by the agent is reported only in the `kill_job` result (no extra message). If the job does not exit within 5 seconds, `kill_job` returns an error result (`exited: false`); the job stays listed as `killing`, and when it finally exits its output is recorded in the conversation without waking the agent (the header notes how long it took to exit after the kill).

The tools add these guidelines to the system prompt: run slow commands as jobs and keep working instead of sleeping or polling; when nothing else is left to do, end the turn, because the result starts a new one; do not run the same command again with `bash` while its job runs; stop jobs that are no longer needed with `kill_job`; use `jobs` only to decide what to do about a running job (for example whether it is stuck), not to poll for its completion.

There is no limit on how many jobs run at once, as there is none on parallel `bash` calls: a fixed number would suit some machines and commands and not others, and an error from it would only make the model retry later. Running jobs are always visible in the footer and in `/jobs`, and you can kill them there.

## Command

| Command | Description |
|---|---|
| `/jobs` / `/jobs list` | List running jobs. Jobs that were sent a kill but have not exited yet are marked `killing`. |
| `/jobs show <id> [lines]` (or `tail`) | Show the last lines (default 20) of a running job's output so far. |
| `/jobs kill <id>...` / `/jobs kill all` | Kill one or more jobs, waiting up to 5s for each to exit. The kill is recorded in the conversation without waking the agent. Jobs that exited are reported as `Killed`; jobs that did not exit yet get a warning and stay listed as `killing` until they do. Unknown ids get a warning. |

Argument completion offers `list`, and `show <id>`, `kill <id>` and `kill all` for the running jobs.

The footer shows `jobs: N running` (and `, M killing`) while jobs are active.

## Completion message

A finished job is added to the conversation as a custom message with `customType: "bash-jobs"`. Its `content` is what the model reads:

```text
Background job job-1 failed (exit 2) after 1m4s: npm test ⏎ npm run lint

<output of the bash tool: the last 2000 lines / 50KB, a truncation note with the full output path, and the status line>
```

- The first line is the header, and it is always one line. The command in it is a summary: lines joined with ` ⏎ `, cut to 80 characters with `…`. A blank line separates it from the output.
- The header says how the job ended: `finished`, `failed (exit N)`, `timed out after … (timeout Ns)`, `was killed`, `failed` (the command could not run, for example a spawn error), or `was interrupted after … because …` (the session ended, see below). Durations read `12.3s`, `1m4s`, `1h2m5s`.
- The `/jobs` list and the `job` result show the same one-line summary.

`details` has the type `BashJobMessageDetails`, exported from `src/index.ts`:

| Field | Description |
|---|---|
| `id` | Job id, for example `job-1`. |
| `command` | The full command. |
| `timeout` | The timeout in seconds, if one was given. |
| `status` | `done` (exit code 0), `failed`, or `killed`. |
| `reason` | Why the job ended: `exit` (the command exited; see `exitCode`), `timeout`, `aborted` (killed), `error` (the command could not run), or `interrupted` (the session ended before the job did). |
| `exitCode` | Exit code, when the command exited. |
| `durationMs` | Run time in milliseconds. |
| `bashDetails` | The bash tool's details: `truncation` and `fullOutputPath` when the output was truncated, also for jobs that timed out or were killed. |

Compatibility: fields are only added, not renamed or removed, without a breaking release noted in the [CHANGELOG](CHANGELOG.md); the same holds for `customType` and the header line. Readers should ignore unknown fields and treat unknown `reason` values like `error`. Messages stored by 0.2.0 and earlier have no `reason`, and their header ends with the full command; they still render as before.

## Modes

| Mode | Behavior |
|---|---|
| Interactive (`pi`) | The completion interrupts the agent after its current tool batch, or starts a new turn when pi is idle. |
| RPC (`pi --mode rpc`) | Same as interactive. When pi is idle, the completion starts a new run that the client receives like any other. |
| Print (`pi -p`) and JSON (`pi --mode json`) | These modes exit when the run settles, which would kill running jobs. Instead, when the model ends its turn while jobs are running, the run waits at its last boundary (`agent_before_settle`) until they finish. Their results reach the model in the same invocation, it continues, and pi exits after that. Jobs that were killed are not waited for. pi waits as long as a job runs, so give commands that might not finish a `timeout`. |

## Session end

A session runtime ends when pi quits, on `/reload`, and when you switch to a new, resumed or forked session. Running jobs are then killed, and pi waits up to 5 seconds (in total) for them to exit before it continues. Each job gets one message in the conversation of the session that ran it, without waking the agent:

```text
Background job job-3 was interrupted after 42.0s because the session was reloaded: npm test

<output so far>
```

The message has `status: "killed"` and `reason: "interrupted"`. A job that did not exit within the wait is recorded with its latest output and a note that it may still be running. So after a reload or `pi -c`, the conversation does not keep a job that waits for a result that will not come.

Job ids continue across runtimes: a new runtime starts numbering after the highest `job-N` in the current branch, so an old `job-1` in the conversation and a new job never share an id.

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
- Jobs do not survive the session runtime: quitting, `/reload`, and switching to a new, resumed or forked session kill them (see [Session end](#session-end)). If pi itself is killed (for example with `SIGKILL`) or crashes, there is no shutdown: nothing is recorded, and the job's processes may keep running.
- Jobs bypass extensions that guard or replace the `bash` tool (permission gates, sandboxes, remote execution). See [Security](#security).
- On Windows with Git Bash, killing a job can leave its child processes running (for example `sleep.exe`). MSYS starts children through intermediate processes that exit, so pi's `taskkill /T` cannot reach them. The built-in bash tool shares this behavior when aborted. Jobs that run to completion are not affected.

## Security

`job` runs shell commands with the same power as `bash`, but it is a separate tool and runs pi's bash implementation directly, not through a call to the tool named `bash`. Extensions that protect or redirect `bash` therefore do not cover jobs:

- **Guards on `bash`.** `tool_call` and `tool_result` handlers that check `event.toolName === "bash"`, such as permission gates, confirmations and command filters (pi's `permission-gate.ts` example), never see a job's command. They do see the `job` call itself: extend them to `job` as well, where the command is `event.input.command`, for example `if (event.toolName !== "bash" && event.toolName !== "job") return;`.
- **Replacements of `bash`.** Extensions that replace the `bash` tool to run commands in an OS sandbox (`examples/extensions/sandbox/`), on a remote host (`ssh.ts`), or with a spawn hook that rewrites the command or environment (`bash-spawn-hook.ts`) do not apply to jobs. A job always runs on the local machine, outside the sandbox, through pi's own bash tool (with the `shellPath` and `shellCommandPrefix` settings, but nothing an extension changed). The model can reach it whenever `job` is active, even without meaning to bypass anything.

If you rely on such an extension, either extend it to `job`, turn the job tools off for a run with `pi --exclude-tools job,kill_job`, or do not load this package in that setup (`pi remove`, or a package entry with `"extensions": []`, see pi's package docs).

The tools declare [annotations](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#tool-exposure) for permission extensions that decide from them: `job` is `destructiveHint: true, openWorldHint: true` (like a shell command), and `kill_job` is `destructiveHint: false, idempotentHint: true, openWorldHint: false`, because it only ends processes that `job` started. `jobs` is `readOnlyHint: true, openWorldHint: false`.

## Development

```bash
npm install      # dev dependencies only, for types and tests
npm run typecheck
npm test
pi -ne -e ./src/index.ts
```

At runtime pi maps `@earendil-works/*` and `typebox` imports to its own copies, so they are peer dependencies.

The tests need:

- **Node 22.19 or later.** `npm test` runs the `.ts` files directly with Node's built-in type stripping (on by default since Node 22.18; pi itself requires 22.19).
- **bash.** Some tests run real commands through pi's bash tool: `/bin/bash` on Linux and macOS, Git Bash on Windows (found the same way pi finds it).

`test/helpers.ts` provides the harness: a fake `ExtensionAPI` that records messages and UI calls, and `fakeBash()`, a bash tool whose runs stay pending until the test resolves or rejects them. Pass it as `createBashJobs({ createBashTool })` to test paths a real process cannot reproduce on demand (a process that ignores the kill, a spawn failure, jobs finishing in a chosen order). Tests wait for messages or poll with a deadline (`waitFor`) instead of sleeping a fixed time, and commands that get killed loop with shell builtins so no child process outlives the kill.

`test/e2e-harness.ts` runs a real pi session runtime (`createAgentSessionRuntime`) with the extension and a scripted faux model (`@earendil-works/pi-ai`), for behavior that depends on pi itself: reload, quit and resume, session replacement.

CI runs the typecheck and the tests on Linux and Windows (Git Bash) for every pull request and push to `main`.

### Releasing

1. Move the `Unreleased` entries in [CHANGELOG.md](CHANGELOG.md) under a new version heading with the date, and set the same `version` in `package.json` (`npm version <x.y.z> --no-git-tag-version` also updates `package-lock.json`). While the version is `0.x`, bump the minor version for breaking changes.
2. Merge that change into `main`, then tag the merge commit and push the tag: `git tag v<x.y.z> && git push origin v<x.y.z>`.
3. Create a GitHub Release for the tag with the CHANGELOG section as its notes (`gh release create v<x.y.z> --notes-file <file>`).

# pi-bash-jobs reference

The precise behavior of the tools, the `/jobs` command, the completion message and the job lifecycle. For an overview, installation and security notes, start with the [README](../README.md).

## Contents

- [Tools](#tools)
  - [`job`](#job)
  - [`jobs`](#jobs)
  - [`kill_job`](#kill_job)
  - [Prompt guidelines](#prompt-guidelines)
  - [Annotations](#annotations)
- [`/jobs` command](#jobs-command)
- [Footer status](#footer-status)
- [Completion message](#completion-message)
  - [Content](#content)
  - [Delivery](#delivery)
  - [Details](#details)
  - [Compatibility](#compatibility)
- [Rendering](#rendering)
- [Execution](#execution)
- [Killing jobs](#killing-jobs)
- [Session end and job ids](#session-end-and-job-ids)
- [Exported API](#exported-api)

## Tools

Every tool returns a text result for the model and a `structuredContent` result for programmatic callers such as codemode scripts, declared with an `outputSchema`. Job ids passed to `jobs` and `kill_job` are trimmed.

### `job`

Start a bash command as a background job and return its id immediately. The row title is `Job`.

| Parameter | Type | Description |
|---|---|---|
| `command` | string | Shell command to execute. |
| `timeout` | number, optional | Timeout in seconds. No timeout by default. |

The parameters are the bash tool's own. Result:

```text
Started background job job-1: npm test
A message will arrive when it finishes. Continue with other work.
```

`structuredContent` is `{ id, command }`, with the full command. The text shows the [one-line summary](#content).

`job` checks its input before it starts and returns an error result instead of starting a job that would fail right away. No job id is used up in that case.

| Error | When |
|---|---|
| `The job tool is disabled: the bash tool is replaced by <path> …` | An extension registered the `bash` tool instead of pi. See [Security](../README.md#security). |
| `Cannot check whether the bash tool is replaced, so no job was started: …` | `pi.getAllTools()` threw. |
| `Invalid timeout: must be a finite number of seconds` | `timeout` is not a finite number above 0. |
| `Invalid timeout: maximum is 2147483.647 seconds` | `timeout` is over the bash tool's limit (the largest `setTimeout` delay). |
| `Custom shell path not found: <path>` | The `shellPath` setting points to a file that does not exist. |
| `Working directory does not exist: <cwd>` | The session's working directory is gone. |

### `jobs`

Read-only. List the running jobs, or show the latest output of one. The row title is `Jobs`.

| Parameter | Type | Description |
|---|---|---|
| `id` | string, optional | Job id to show the latest output of, for example `job-1`. |
| `tail` | integer, optional | Number of output lines to show, 1 to 500. Default 20. |

Without `id`, the text has one line per running job, or `No running jobs.`:

```text
job-1 (12.3s): npm test
job-2 (1m4s, killing): make ⏎ make install
```

With `id`, it shows that job and the last `tail` lines of its output so far, and the full output file once the bash tool has truncated the output:

```text
job-1 (12.3s): npm test
Output so far (last 3 lines):
✔ parser (41 tests)
✔ renderer (18 tests)
… running integration tests
Full output so far: <path of the bash tool's full output file>
```

A job with no output yet shows `No output yet.` An unknown id is an error result that lists the running jobs.

`structuredContent` is `{ jobs: [{ id, command, state, elapsed_seconds, timeout? }], output? }`. `state` is `running` or `killing` (a kill was sent, but the process has not exited yet), `elapsed_seconds` is rounded to 0.1, and `output` (only with `id`) is the last `tail` lines.

### `kill_job`

Kill a running job and its child processes, wait up to 5 seconds for it to exit, and return its output so far. The row title is `Kill Job`.

| Parameter | Type | Description |
|---|---|---|
| `id` | string | Job id returned by the `job` tool, for example `job-1`. |

When the job exits within the wait, the text is the job's [header](#content) and output, and the job gets no completion message:

```text
Background job job-2 was killed after 2m12s: npm run build

<output so far>

Command aborted
```

When it does not, the result is an error: `Sent kill to job-2, but it did not exit within 5s. It is listed as killing until it exits; its output will then be recorded in the conversation.` See [Killing jobs](#killing-jobs).

| Field | `structuredContent` |
|---|---|
| `id` | The job id. |
| `exited` | Whether the job exited within the wait. |
| `status` | `done`, `failed`, `killed`, or `killing` (not exited yet). A job that ended on its own just before the kill reports `done` or `failed`. |
| `exit_code` | Exit code, when the command exited. |
| `output` | Output so far, truncated like the bash tool. |

An id that is not running (unknown, or already finished) is an error result that lists the running jobs.

### Prompt guidelines

The tools add these lines to the system prompt.

`job` (snippet: *Run a long bash command in the background; you are notified when it finishes*):

- Use the job tool for builds, test suites and other slow commands, then keep working on something else; do not sleep or poll to wait for the job.
- When nothing else is left to do while a job runs, end your turn: the job's result arrives as a new message and starts a new turn.
- Do not run a command again with bash while it runs as a job; wait for its result instead.
- Use kill_job to stop a background job you no longer need.

`jobs` (snippet: *List running background jobs, or show the latest output of one*):

- Use the jobs tool only to decide what to do about a running job (for example whether to kill it), not to poll for its completion: the result arrives on its own.

The `job` tool description also says it is not for servers or watchers that never exit.

### Annotations

| Tool | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
|---|---|---|---|---|
| `job` | `false` | `true` | `false` | `true` |
| `kill_job` | `false` | `false` | `true` | `false` |
| `jobs` | `true` | | | `false` |

`job` is annotated like a shell command. `kill_job` only ends processes that `job` started, and repeating it has no further effect. See [Tool annotations](../README.md#tool-annotations).

## `/jobs` command

```text
/jobs [list | show <id> [lines] | kill <id>... | kill all]
```

| Command | Behavior |
|---|---|
| `/jobs`, `/jobs list` | Show the running jobs in a notification, one line each as in the [`jobs`](#jobs) tool, or `No running jobs.` |
| `/jobs show <id> [lines]`, `/jobs tail <id> [lines]` | Show a running job and the last `lines` lines (default 20, at most 500) of its output so far. An unknown id gets a warning. |
| `/jobs kill <id>...` | Kill the given jobs (duplicates are ignored) and wait up to 5 seconds for each to exit. Unknown ids get a warning: `No running job "job-9".` |
| `/jobs kill all` | Kill every running job. `all` cannot be combined with ids. |

After a kill, jobs that exited are reported as `Killed job-1, job-2`. Jobs that have not exited get a warning (`Sent kill to job-3, but it did not exit within 5s. It is listed as killing until it exits.`) and stay listed as `killing`. Kills from `/jobs` are recorded in the conversation [without waking the agent](#delivery).

Other arguments (an unknown subcommand, extra words, a `lines` value that is not a positive integer) show the usage line as a warning.

Argument completion offers `list` at all times, and `show <id>`, `kill <id>` and `kill all` for the running jobs.

## Footer status

While jobs are active, the footer shows `jobs: 2 running`, `jobs: 1 running, 1 killing` or `jobs: 1 killing`. It is cleared when no job is left. The status appears only in modes with a UI.

## Completion message

A job that ends gets one custom message in the conversation, with `customType: "bash-jobs"` and `display: true`. The exceptions are a job killed by `kill_job` that exits within the wait (the tool result reports it) and the [session end](#session-end-and-job-ids) record, which replaces the completion message.

### Content

The content is what the model reads: a one-line header, a blank line, and the bash tool's output.

```text
Background job job-1 failed (exit 2) after 1m4s: npm test ⏎ npm run lint

<output of the bash tool: the last 2000 lines / 50KB, a truncation note with the full output path, and the status line>
```

| Header | `status` | `reason` |
|---|---|---|
| `Background job job-1 finished after 12.3s: …` | `done` | `exit` (exit code 0) |
| `Background job job-1 failed (exit 2) after 12.3s: …` | `failed` | `exit` |
| `Background job job-1 timed out after 10.0s (timeout 10s): …` | `failed` | `timeout` |
| `Background job job-1 failed after 0.1s: …` | `failed` | `error`: the command could not run (for example a spawn error) or ended without an exit code |
| `Background job job-1 was killed after 5.2s: …` | `killed` | `aborted` |
| `Background job job-1 was killed after 9.8s (exited 4.6s after the kill request): …` | `killed` | `aborted`, when the kill wait had timed out |
| `Background job job-1 was interrupted after 42.0s because the session was reloaded: …` | `killed` | `interrupted` |

- **The command is a summary:** its lines are trimmed, blank lines dropped, the rest joined with ` ⏎ `, and the result cut to 80 characters with `…`. The `/jobs` list, the `jobs` tool and the `job` result use the same summary. `details.command` keeps the full command.
- **Durations** read `12.3s` under a minute, then `1m4s` and `1h2m5s`. They are rounded before they are split, so 59.96 seconds reads `1m0s`.
- **The output** is the bash tool's text: the last 2000 lines or 50KB, and a note like `[Showing lines 1201-3200 of 3200. Full output: <path>]` when it was truncated. A command that did not exit with 0 ends with the bash tool's status line (`Command exited with code N`, `Command timed out after N seconds`, `Command aborted`); a command that could not run shows the error instead.

### Delivery

| Event | Sent with | Effect |
|---|---|---|
| The command ended on its own (exit, timeout, error) | `triggerTurn: true, deliverAs: "steer"` | Interrupts a running agent after its current tool batch, or starts a new turn when pi is idle |
| Killed with `/jobs kill` | `triggerTurn: false` | Recorded for the agent's context without waking it |
| Killed with `kill_job`, exited within the wait | (no message) | The `kill_job` result reports it |
| Killed with `kill_job`, exited after the wait | `triggerTurn: false` | Recorded without waking the agent |
| The session ended | `triggerTurn: false` | Recorded in the session that ran the job |

A kill was requested on purpose, so its end needs no new decision from the agent.

### Details

`details` has the type `BashJobMessageDetails`, exported from [`src/index.ts`](../src/index.ts):

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

### Compatibility

Fields are only added, not renamed or removed, without a breaking release noted in the [CHANGELOG](../CHANGELOG.md); the same holds for `customType` and the header line. Readers should ignore unknown fields and treat unknown `reason` values like `error`.

Messages stored by 0.2.0 and earlier have no `reason`, and their header ends with the full command; they still render as before.

## Rendering

- **Completion rows** are drawn by a message renderer that returns pi's own `ToolExecutionComponent` for `bash` with the bash tool's renderers, so a finished job looks like a finished `bash` call: `$ command` (with ` (timeout Ns)` when set) and ` · job-1`, the output preview without the header, the truncation warning and full output path, and `Took …`. The row is marked as an error unless `status` is `done`, and it expands with pi's tool expand key (ctrl+o by default).
- **Row titles.** The completion row and the `job` start row are labeled `Job`, `kill_job` is labeled `Kill Job`, and `jobs` is labeled `Jobs`. Display extensions use the label as the row title.
- **Display extensions** that restyle bash rows by patching `ToolExecutionComponent` apply to completion rows too.
- **Renderers registered with `pi.registerToolRenderer` for `bash` are not consulted,** because extensions cannot query that chain.
- The completion row uses the `outputPad` and `durationMs` render options added in pi 1.1.0.

## Execution

Each job runs through pi's bash tool definition, `createBashToolDefinition(cwd, { shellPath, commandPrefix })`, created with the `shellPath` and `shellCommandPrefix` settings the way pi creates the built-in `bash` tool. Shell resolution (Git Bash on Windows, or `shellPath`), the command prefix, `PI_*` environment variables, `timeout`, process-tree kill, output truncation (last 2000 lines / 50KB) and the full-output temp file behave like the built-in `bash` tool.

The differences:

- **Settings are read per job.** A job reads the settings with `pi.getSettings()` when it starts; the built-in tool reads them when the session starts or reloads. Without `pi.getSettings()` (older pi), jobs use pi's default shell.
- **`job` refuses to start while an extension replaces `bash`.** See [Security](../README.md#security).
- **`tool_call` guards on `bash` do not see a job's command.** They see the `job` call, with the command in `event.input.command`.
- **The exit code** comes from the bash tool's `structuredContent` (pi 0.99.0 and later).

The latest output of a running job (the bash tool's partial results) is what `jobs`, `/jobs show`, a timed-out kill and the session end record show.

There is no limit on concurrent jobs, and no interactive shell or PTY.

## Killing jobs

A kill (`kill_job` or `/jobs kill`) aborts the job, which makes the bash tool kill its process tree, and waits up to 5 seconds for the process to exit. The job is listed as `killing` from the kill until it exits.

| Who | Exited within 5 seconds | Did not exit within 5 seconds |
|---|---|---|
| The agent (`kill_job`) | The tool result reports the outcome; no message | Error result (`exited: false`); a message is recorded without waking the agent when the job exits, and its header says how long that took after the kill request |
| The user (`/jobs kill`) | `Killed job-N`; a message is recorded without waking the agent | A warning; a message is recorded without waking the agent when the job exits |

In print and JSON mode, killed jobs are not waited for before pi exits. On Windows with Git Bash, a kill can leave child processes running; see [Limitations](../README.md#limitations).

## Session end and job ids

A session runtime ends when pi quits, on `/reload`, and when you switch to a new, resumed or forked session. Running jobs are killed, and pi waits up to 5 seconds in total for them to exit. Each job then gets one `interrupted` message (`status: "killed"`, `reason: "interrupted"`) in the session that ran it, without waking the agent. A job that did not exit within the wait is recorded with its latest output (or `(no output)`) and the note `The process did not exit within 5s of the kill and may still be running.`

| Session end | Header says |
|---|---|
| Quit | `because pi exited` |
| `/reload` | `because the session was reloaded` |
| New session | `because a new session was started` |
| Resume another session | `because another session was resumed` |
| Fork | `because the session was forked` |

Job ids continue across runtimes. A new runtime starts numbering after the highest `job-N` in the current branch, found in `job` and `kill_job` results and in job messages, so an old `job-1` in the conversation and a new job never share an id.

If pi is killed (for example with `SIGKILL`) or crashes, there is no shutdown: nothing is recorded, and the job's processes may keep running.

## Exported API

The package is installed by pi from git and is not published to npm. Its entry point, [`src/index.ts`](../src/index.ts), exports:

| Export | Description |
|---|---|
| `default` | The extension, built with the defaults (`createBashJobs()`). |
| `createBashJobs(options?)` | Build the extension factory. `options.createBashTool` replaces the bash tool definition (default: pi's `createBashToolDefinition`), and `options.killWaitMs` sets how long a kill waits for the exit (default 5000). The tests use it to simulate processes that do not exit or fail to spawn. |
| `summarizeCommand(command, max = 80)` | The one-line command summary used in headers and lists. |
| `formatDuration(ms)` | The duration format used in headers and lists. |
| `BashJobMessageDetails` | Type of the completion message `details`. |
| `JobEndReason` | `"exit" \| "timeout" \| "aborted" \| "error" \| "interrupted"`. |
| `BashJobsOptions`, `BashToolFactory` | Types of the `createBashJobs` options. |

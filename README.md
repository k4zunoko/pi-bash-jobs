# pi-bash-jobs

A small [pi](https://pi.dev) extension that runs bash commands as background jobs and interrupts the agent when they finish.

Start a build or test run, keep working on something else, and get the result as soon as it is done.

## Design

- **Execution is pi's own bash tool.** Jobs run through `createBashToolDefinition().execute()`, so shell resolution (Git Bash on Windows), `PI_*` environment variables, `timeout`, process-tree kill, output truncation (last 2000 lines / 50KB) and the full-output temp file behave exactly like the built-in `bash` tool.
- **Completion is a steer message.** `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })` interrupts a running agent after its current tool batch, or starts a new turn when pi is idle.
- **Completion is drawn as a bash tool row.** The message renderer returns pi's own `ToolExecutionComponent` for `bash` with the bash tool's renderers, so it looks like a finished `bash` call (`$ command · background job-1`, output preview, `Took Ns`, ctrl+o to expand). The row is labeled `Bash Job`, which display extensions use as its title. Display extensions that restyle bash rows by patching `ToolExecutionComponent` apply to it too. Renderers registered with `pi.registerToolRenderer` for `bash` are not consulted, because extensions cannot query that chain.
- **No interactive shell, no PTY, no persistence.** Jobs live as long as the session.

## Tools

| Tool | Description |
|---|---|
| `bash_job { command, timeout? }` | Start a background job and return its id (`job-1`, ...) immediately. |
| `bash_job_kill { id }` | Kill a running job and its child processes; returns the output so far. |

A job killed by the agent is reported only in the `bash_job_kill` result (no extra message).

## Command

| Command | Description |
|---|---|
| `/bash-jobs` | List running jobs. |
| `/bash-jobs kill <id>` / `/bash-jobs kill all` | Kill jobs. The kill is recorded in the conversation without waking the agent. |

The footer shows `bash jobs: N running` while jobs are active.

## Install

```bash
pi install C:\programs\pi-bash-jobs
```

A local package is loaded in place; edit and run `/reload` to apply changes.

## Limitations

- Meant for commands that finish on their own (builds, tests). Servers and watchers never complete, so they never notify.
- All jobs are killed silently when the session shuts down, reloads, or is replaced.
- Extensions that guard the tool named `bash` (permission gates, confirmations) do not see `bash_job`; add it to them if needed.
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

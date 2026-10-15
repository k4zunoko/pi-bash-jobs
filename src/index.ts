/**
 * pi-bash-jobs
 *
 * Run bash commands as background jobs and get interrupted when they finish.
 *
 * Execution is delegated to pi's built-in bash tool (`createBashToolDefinition`),
 * so shell resolution, PI_* environment, timeouts, process-tree kill, output
 * truncation and full-output temp files behave exactly like the normal `bash` tool.
 * Completion is delivered with `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })`:
 * it interrupts a running agent after the current tool batch, or starts a new turn when idle.
 */

import { existsSync } from "node:fs";
import type {
	AgentToolResult,
	BashToolDetails,
	BashToolOptions,
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	SessionEntry,
	SessionShutdownEvent,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

const MESSAGE_TYPE = "bash-jobs";
const STATUS_KEY = "bash-jobs";
const TUI_CAPTURE_KEY = "bash-jobs:tui";
const KILL_WAIT_MS = 5_000;
/** Tools whose results carry a job id in `details.id`. */
const JOB_TOOLS = new Set(["job", "kill_job"]);
/** The bash tool's timeout limit (the largest setTimeout delay), in seconds. */
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

const KILL_JOB_OUTPUT = Type.Object({
	id: Type.String(),
	exited: Type.Boolean({ description: "Whether the job exited within the kill wait" }),
	status: Type.Union([Type.Literal("done"), Type.Literal("failed"), Type.Literal("killed"), Type.Literal("killing")], {
		description: "killing: the kill was sent but the job has not exited yet",
	}),
	exit_code: Type.Optional(Type.Number()),
	output: Type.String({ description: "Output so far, truncated like the bash tool" }),
});
type KillJobOutput = Static<typeof KILL_JOB_OUTPUT>;

/** Reject input the bash tool would reject as soon as it runs, with the same messages. */
function validateStart(params: { timeout?: number }, cwd: string, shell: BashToolOptions) {
	const { timeout } = params;
	if (timeout !== undefined) {
		if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid timeout: must be a finite number of seconds");
		if (timeout > MAX_TIMEOUT_SECONDS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	if (shell.shellPath && !existsSync(shell.shellPath)) throw new Error(`Custom shell path not found: ${shell.shellPath}`);
	if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
}

/** Text of the latest partial result: the output tail so far. */
const latestText = (job: Job) => job.latest?.content.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";

/** Why `job` refuses to start while an extension replaces `bash`. */
const replacedBashMessage = (replacedBy: string) =>
	`The job tool is disabled: the bash tool is replaced by ${replacedBy} (for example to run commands in a sandbox or on another host). ` +
	"Jobs run pi's built-in bash on this machine and would bypass that replacement, so no job was started. Run the command with the bash tool instead.";

const DEFAULT_TAIL_LINES = 20;
/** The bash tool keeps the last 2000 lines (or 50KB); this bounds what one call can pull into context. */
const MAX_TAIL_LINES = 500;

const JOBS_OUTPUT = Type.Object({
	jobs: Type.Array(
		Type.Object({
			id: Type.String(),
			command: Type.String(),
			state: Type.Union([Type.Literal("running"), Type.Literal("killing")], { description: "killing: a kill was sent, not exited yet" }),
			elapsed_seconds: Type.Number(),
			timeout: Type.Optional(Type.Number()),
		}),
	),
	output: Type.Optional(Type.String({ description: "With `id`: the last `tail` lines of that job's output so far" })),
});
type JobsOutput = Static<typeof JOBS_OUTPUT>;

function jobInfo(job: Job): JobsOutput["jobs"][number] {
	const info: JobsOutput["jobs"][number] = {
		id: job.id,
		command: job.command,
		state: job.state,
		elapsed_seconds: Math.round((Date.now() - job.startedAt) / 100) / 10,
	};
	if (job.timeout !== undefined) info.timeout = job.timeout;
	return info;
}

/** One line per running job, as in the `/jobs` list. */
function runningLine(job: Job): string {
	const state = job.state === "killing" ? ", killing" : "";
	return `${job.id} (${formatDuration(Date.now() - job.startedAt)}${state}): ${summarizeCommand(job.command)}`;
}

/** The last `n` lines of `text`, without a trailing newline. */
function tailLines(text: string, n: number): string {
	if (text === "") return "";
	return text.replace(/\n$/, "").split("\n").slice(-n).join("\n");
}

/** A running job with the last `n` lines of its output so far. */
function showJob(job: Job, n: number): string {
	const output = tailLines(latestText(job), n);
	const fullOutputPath = job.latest?.details?.fullOutputPath;
	return [
		runningLine(job),
		output ? `Output so far (last ${n} lines):\n${output}` : "No output yet.",
		...(fullOutputPath ? [`Full output so far: ${fullOutputPath}`] : []),
	].join("\n");
}

type JobStatus = "done" | "failed" | "killed";

/**
 * Why a job ended: the command exited (`exit`, with an exit code), hit its `timeout`, was killed
 * (`aborted`), could not run or was ended otherwise (`error`, for example a spawn failure), or was
 * killed because the session shut down, reloaded or was replaced (`interrupted`).
 */
export type JobEndReason = "exit" | "timeout" | "aborted" | "error" | "interrupted";

interface JobOutcome {
	status: JobStatus;
	reason: JobEndReason;
	exitCode?: number;
	text: string;
	durationMs: number;
	bashDetails?: BashToolDetails;
}

interface Job {
	id: string;
	command: string;
	timeout?: number;
	startedAt: number;
	controller: AbortController;
	done: Promise<JobOutcome>;
	/** Settles once the completion has been handled (reported, recorded or suppressed). */
	reported: Promise<void>;
	/** Latest partial result of the bash tool: the output tail so far and its truncation details. */
	latest?: AgentToolResult<BashToolDetails | undefined>;
	/** `killing` once a kill was sent, until the process has exited. */
	state: "running" | "killing";
	/** Who requested the kill. Agent kills are reported by the kill tool itself while it waits. */
	killedBy?: "agent" | "user";
	/** When the first kill was sent. */
	killRequestedAt?: number;
	/** Kill calls currently waiting for the exit; their results report the outcome. */
	killWaiters: number;
	/** A kill gave up waiting, so the exit comes later and is recorded on its own. */
	killWaitTimedOut?: boolean;
	/** Suppress the completion message (session is shutting down). */
	silenced?: boolean;
}

/** `details` of the `bash-jobs` completion message. See "Completion message" in the README. */
export interface BashJobMessageDetails {
	id: string;
	/** The full command. The header in `content` shows a one-line summary. */
	command: string;
	timeout?: number;
	status: JobStatus;
	/** Why the job ended. Missing in messages written by 0.2.0 and earlier. */
	reason?: JobEndReason;
	exitCode?: number;
	durationMs: number;
	/** Bash tool details (truncation, full output path), used to render like a bash tool result. */
	bashDetails?: BashToolDetails;
}

const COMMAND_SUMMARY_MAX = 80;

/** One line for headers and lists: lines joined with ⏎, cut to `max` characters with an ellipsis. */
export function summarizeCommand(command: string, max = COMMAND_SUMMARY_MAX): string {
	const oneLine = command
		.split(/\r\n|\r|\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.join(" ⏎ ");
	const chars = Array.from(oneLine);
	return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : oneLine;
}

/** `12.3s` under a minute, then `1m5s` and `1h2m5s`, rounded before splitting so 59.96s is `1m0s`. */
export function formatDuration(ms: number): string {
	const tenths = Math.round(ms / 100);
	if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
	const total = Math.round(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return h > 0 ? `${h}h${m}m${s}s` : `${m}m${s}s`;
}

function describeOutcome(job: Job, outcome: JobOutcome): string {
	const after = `after ${formatDuration(outcome.durationMs)}`;
	// A kill that gave up waiting: say how long the process took to exit after it.
	const late =
		job.killWaitTimedOut && job.killRequestedAt !== undefined
			? ` (exited ${formatDuration(job.startedAt + outcome.durationMs - job.killRequestedAt)} after the kill request)`
			: "";
	const what =
		outcome.status === "done"
			? `finished ${after}`
			: outcome.status === "killed"
				? `was killed ${after}${late}`
				: outcome.reason === "timeout"
					? `timed out ${after} (timeout ${job.timeout}s)`
					: outcome.exitCode !== undefined
						? `failed (exit ${outcome.exitCode}) ${after}`
						: `failed ${after}`;
	return `Background job ${job.id} ${what}: ${summarizeCommand(job.command)}`;
}

/** The bash output of a completion message: everything after the header. */
function outputOf(raw: string, d: BashJobMessageDetails): string {
	// Messages without `reason` (0.2.0 and earlier) end the header with the full command, which can
	// contain blank lines. Newer headers are always one line.
	if (d.reason === undefined) {
		const legacy = raw.indexOf(`: ${d.command}\n\n`);
		if (legacy >= 0) return raw.slice(legacy + d.command.length + 4);
	}
	const end = raw.indexOf("\n\n");
	return end >= 0 ? raw.slice(end + 2) : "";
}

/** Creates the bash tool definition that jobs run through; pi's `createBashToolDefinition` by default. */
export type BashToolFactory = (cwd: string, options?: BashToolOptions) => ReturnType<typeof createBashToolDefinition>;

export interface BashJobsOptions {
	/** Replace the bash tool definition, for example with a fake in tests. Default: `createBashToolDefinition`. */
	createBashTool?: BashToolFactory;
	/** How long a kill waits for the job to exit, in milliseconds. Default: 5000. */
	killWaitMs?: number;
}

/** Build the extension factory. The default export uses the defaults; tests inject a fake bash tool. */
export function createBashJobs(options: BashJobsOptions = {}) {
	const createBashTool = options.createBashTool ?? createBashToolDefinition;
	const killWaitMs = options.killWaitMs ?? KILL_WAIT_MS;
	return function bashJobs(pi: ExtensionAPI) {
		registerBashJobs(pi, createBashTool, killWaitMs);
	};
}

export default createBashJobs();

function registerBashJobs(pi: ExtensionAPI, createBashTool: BashToolFactory, killWaitMs: number) {
	/** Used for the `job` parameters and the completion row renderers; each job runs on its own definition. */
	const bash = createBashTool(process.cwd());
	const jobs = new Map<string, Job>();
	let seq = 0;
	let uiCtx: ExtensionContext | undefined;
	/** The interactive TUI, captured so completion cards can repaint themselves like live tool rows. */
	let tui: TUI | undefined;

	/**
	 * Where the `bash` tool comes from, when an extension (or SDK host) registered its own `bash` in
	 * place of pi's built-in one; `undefined` for the built-in tool, no `bash` tool, or a pi without
	 * `getAllTools`. Throws if the check fails, so a job never starts unchecked.
	 */
	const bashReplacement = (): string | undefined => {
		if (typeof pi.getAllTools !== "function") return undefined;
		let tools: ReturnType<ExtensionAPI["getAllTools"]>;
		try {
			tools = pi.getAllTools();
		} catch (err) {
			throw new Error(`Cannot check whether the bash tool is replaced, so no job was started: ${err instanceof Error ? err.message : String(err)}`);
		}
		const bashTool = tools.find((tool) => tool.name === "bash");
		if (!bashTool || bashTool.sourceInfo?.source === "builtin") return undefined;
		return bashTool.sourceInfo?.path || "another extension";
	};

	/**
	 * The shell settings pi creates the built-in bash tool with (`shellPath`, `shellCommandPrefix`),
	 * read when each job starts. Without `pi.getSettings` (older pi), pi's default shell is used.
	 */
	const shellSettings = (): BashToolOptions => {
		try {
			const settings = typeof pi.getSettings === "function" ? pi.getSettings() : undefined;
			return { shellPath: settings?.shellPath || undefined, commandPrefix: settings?.shellCommandPrefix || undefined };
		} catch {
			return {};
		}
	};

	const safeUi = (fn: (ctx: ExtensionContext) => void) => {
		if (!uiCtx?.hasUI) return;
		try {
			fn(uiCtx);
		} catch {
			// The context can go stale after session replacement; UI hints are best effort.
		}
	};

	const updateStatus = () =>
		safeUi((ctx) => {
			const all = [...jobs.values()];
			const killing = all.filter((j) => j.state === "killing").length;
			const running = all.length - killing;
			const parts = [running > 0 ? `${running} running` : "", killing > 0 ? `${killing} killing` : ""].filter(Boolean);
			ctx.ui.setStatus(STATUS_KEY, parts.length > 0 ? `jobs: ${parts.join(", ")}` : undefined);
		});

	const listRunning = () => (jobs.size === 0 ? "No running jobs." : [...jobs.values()].map(runningLine).join("\n"));

	async function run(
		job: Job,
		runner: ReturnType<BashToolFactory>,
		params: { command: string; timeout?: number },
		ctx: ExtensionToolContext,
	): Promise<JobOutcome> {
		// The bash tool sends its last snapshot (with truncation and the full output path) before it
		// throws on a timeout or abort, so keep it for the failure paths.
		const onUpdate = (partial: AgentToolResult<BashToolDetails | undefined>) => {
			job.latest = partial;
		};
		try {
			const result = await runner.execute(job.id, params, job.controller.signal, onUpdate, ctx);
			const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
			const exitCode = (result.structuredContent as { exit_code?: number } | undefined)?.exit_code;
			return {
				status: result.isError ? "failed" : "done",
				reason: "exit",
				exitCode,
				text,
				durationMs: Date.now() - job.startedAt,
				bashDetails: result.details,
			};
		} catch (err) {
			// Timeouts, aborts and spawn errors are thrown by the bash tool with the output tail in the message.
			const text = err instanceof Error ? err.message : String(err);
			const aborted = job.controller.signal.aborted;
			const timedOut = !aborted && job.timeout !== undefined && /Command timed out after [^\n]* seconds$/.test(text);
			const details = job.latest?.details;
			return {
				status: aborted ? "killed" : "failed",
				reason: aborted ? "aborted" : timedOut ? "timeout" : "error",
				text,
				durationMs: Date.now() - job.startedAt,
				bashDetails: details?.truncation ? details : undefined,
			};
		}
	}

	function report(job: Job, outcome: JobOutcome) {
		if (job.silenced) return;
		// A kill_job call that is still waiting returns the outcome as its result.
		if (job.killedBy === "agent" && job.killWaiters > 0) return;
		const header = describeOutcome(job, outcome);
		const details: BashJobMessageDetails = {
			id: job.id,
			command: job.command,
			timeout: job.timeout,
			status: outcome.status,
			reason: outcome.reason,
			exitCode: outcome.exitCode,
			durationMs: outcome.durationMs,
			bashDetails: outcome.bashDetails,
		};
		// A kill (by the user, or by the agent once kill_job stopped waiting) is recorded for the agent's
		// context without waking it up: the kill was requested, so its end needs no new decision.
		const options = job.killedBy ? { triggerTurn: false } : { triggerTurn: true, deliverAs: "steer" as const };
		pi.sendMessage<BashJobMessageDetails>(
			{ customType: MESSAGE_TYPE, content: `${header}\n\n${outcome.text}`, display: true, details },
			options,
		);
	}

	function start(params: { command: string; timeout?: number }, ctx: ExtensionToolContext, shell: BashToolOptions): Job {
		const job = {
			id: `job-${++seq}`,
			command: params.command,
			timeout: params.timeout,
			startedAt: Date.now(),
			controller: new AbortController(),
			state: "running",
			killWaiters: 0,
		} as Job;
		// A bash tool per job, created like pi creates the built-in one, so the shell settings apply.
		job.done = run(job, createBashTool(ctx.cwd, shell), params, ctx);
		jobs.set(job.id, job);
		updateStatus();
		job.reported = job.done
			.then((outcome) => {
				jobs.delete(job.id);
				updateStatus();
				report(job, outcome);
			})
			.catch(() => {
				// sendMessage throws once the runtime is stale; the job is already cleaned up above.
			});
		return job;
	}

	/** Abort the job and wait up to `killWaitMs` for it to exit. Resolves `undefined` if it is still running. */
	async function kill(job: Job, by: "agent" | "user"): Promise<JobOutcome | undefined> {
		job.killedBy = by;
		job.killRequestedAt ??= Date.now();
		if (job.state !== "killing") {
			job.state = "killing";
			updateStatus();
		}
		job.controller.abort();
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<undefined>((resolve) => {
			timer = setTimeout(() => resolve(undefined), killWaitMs);
		});
		job.killWaiters++;
		try {
			const outcome = await Promise.race([job.done, timeout]);
			if (!outcome) job.killWaitTimedOut = true;
			return outcome;
		} finally {
			job.killWaiters--;
			clearTimeout(timer);
		}
	}

	pi.registerTool({
		name: "job",
		label: "Job",
		// Like a shell command: it can change or delete anything and reach the network. Permission
		// extensions that read annotations confirm it like `bash` (see Security in the README).
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		description:
			"Start a bash command as a background job and return its job id immediately. " +
			"When the command finishes, its output (truncated like the bash tool) arrives as a message that interrupts your current work. " +
			"Use for long-running commands that finish on their own, such as builds and test suites. " +
			"Not for servers or watchers that never exit. Optionally provide a timeout in seconds.",
		promptSnippet: "Run a long bash command in the background; you are notified when it finishes",
		promptGuidelines: [
			"Use the job tool for builds, test suites and other slow commands, then keep working on something else; do not sleep or poll to wait for the job.",
			"When nothing else is left to do while a job runs, end your turn: the job's result arrives as a new message and starts a new turn.",
			"Do not run a command again with bash while it runs as a job; wait for its result instead.",
			"Use kill_job to stop a background job you no longer need.",
		],
		parameters: bash.parameters,
		outputSchema: Type.Object({
			id: Type.String({ description: "Job id, e.g. job-1" }),
			command: Type.String(),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			uiCtx = ctx;
			// Jobs run pi's built-in bash implementation; refuse rather than bypass an extension that
			// replaced `bash` (sandbox, remote host, spawn hook).
			const replacedBy = bashReplacement();
			if (replacedBy) throw new Error(replacedBashMessage(replacedBy));
			// Fail fast for input the bash tool would reject right away, instead of a "started" result
			// followed by a failure message that interrupts the agent.
			const shell = shellSettings();
			validateStart(params, ctx.cwd, shell);
			const job = start(params, ctx, shell);
			return {
				content: [
					{
						type: "text",
						text: `Started background job ${job.id}: ${summarizeCommand(job.command)}\nA message will arrive when it finishes. Continue with other work.`,
					},
				],
				details: { id: job.id },
				structuredContent: { id: job.id, command: job.command },
			};
		},
	});

	pi.registerTool({
		name: "kill_job",
		label: "Kill Job",
		// Only ends processes that `job` started (and was allowed to start); repeating it has no further effect.
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		description:
			"Kill a running background job started with the job tool (including its child processes) and return its output so far. " +
			`Waits up to ${killWaitMs / 1000}s for the job to exit; if it does not, the result is an error and the output is recorded in the conversation when it exits.`,
		parameters: Type.Object({
			id: Type.String({ description: "Job id returned by the job tool, e.g. job-1" }),
		}),
		outputSchema: KILL_JOB_OUTPUT,
		async execute(_toolCallId, { id }, _signal, _onUpdate, ctx) {
			uiCtx = ctx;
			const job = jobs.get(id.trim());
			if (!job) throw new Error(`No running job "${id}".\nRunning jobs:\n${listRunning()}`);
			const outcome = await kill(job, "agent");
			if (!outcome) {
				// An error for the model; scripts still get the data.
				return {
					content: [
						{
							type: "text",
							text:
								`Sent kill to ${job.id}, but it did not exit within ${killWaitMs / 1000}s. ` +
								"It is listed as killing until it exits; its output will then be recorded in the conversation.",
						},
					],
					details: { id: job.id, exited: false },
					structuredContent: { id: job.id, exited: false, status: "killing", output: latestText(job) } satisfies KillJobOutput,
					isError: true,
				};
			}
			const structuredContent: KillJobOutput = { id: job.id, exited: true, status: outcome.status, output: outcome.text };
			if (outcome.exitCode !== undefined) structuredContent.exit_code = outcome.exitCode;
			return {
				content: [{ type: "text", text: `${describeOutcome(job, outcome)}\n\n${outcome.text}` }],
				details: { id: job.id, exited: true, status: outcome.status, reason: outcome.reason, exitCode: outcome.exitCode },
				structuredContent,
			};
		},
	});

	pi.registerTool({
		name: "jobs",
		label: "Jobs",
		description:
			"List the running background jobs started with the job tool, or show the latest output of one job (`id`, with the last `tail` lines, default " +
			`${DEFAULT_TAIL_LINES}). Read-only. Use it to decide what to do about a running job, for example whether it is stuck and should be killed.`,
		promptSnippet: "List running background jobs, or show the latest output of one",
		promptGuidelines: [
			"Use the jobs tool only to decide what to do about a running job (for example whether to kill it), not to poll for its completion: the result arrives on its own.",
		],
		annotations: { readOnlyHint: true, openWorldHint: false },
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Job id to show the latest output of, e.g. job-1" })),
			tail: Type.Optional(
				Type.Integer({ minimum: 1, maximum: MAX_TAIL_LINES, description: `Number of output lines to show (default ${DEFAULT_TAIL_LINES})` }),
			),
		}),
		outputSchema: JOBS_OUTPUT,
		async execute(_toolCallId, { id, tail }, _signal, _onUpdate, ctx) {
			uiCtx = ctx;
			const structuredContent: JobsOutput = { jobs: [...jobs.values()].map(jobInfo) };
			if (id === undefined) {
				return { content: [{ type: "text", text: listRunning() }], details: undefined, structuredContent };
			}
			const job = jobs.get(id.trim());
			if (!job) throw new Error(`No running job "${id}".\nRunning jobs:\n${listRunning()}`);
			structuredContent.output = tailLines(latestText(job), tail ?? DEFAULT_TAIL_LINES);
			return { content: [{ type: "text", text: showJob(job, tail ?? DEFAULT_TAIL_LINES) }], details: undefined, structuredContent };
		},
	});

	const USAGE = "Usage: /jobs [list | show <id> [lines] | kill <id>... | kill all]";
	pi.registerCommand("jobs", {
		description: "List background bash jobs, show one's latest output, or kill jobs: /jobs [list | show <id> [lines] | kill <id>... | kill all]",
		getArgumentCompletions: (prefix) => {
			const ids = [...jobs.keys()];
			const values = [
				"list",
				...ids.map((id) => `show ${id}`),
				...ids.map((id) => `kill ${id}`),
				...(ids.length > 0 ? ["kill all"] : []),
			];
			const matches = values.filter((v) => v.startsWith(prefix.trimStart())).map((v) => ({ value: v, label: v }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			uiCtx = ctx;
			const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (!sub || sub === "list") {
				if (rest.length > 0) ctx.ui.notify(USAGE, "warning");
				else ctx.ui.notify(listRunning(), "info");
				return;
			}
			if (sub === "show" || sub === "tail") {
				const [target, lines, ...extra] = rest;
				const count = lines === undefined ? DEFAULT_TAIL_LINES : Number(lines);
				if (!target || extra.length > 0 || !Number.isInteger(count) || count < 1) {
					ctx.ui.notify(USAGE, "warning");
					return;
				}
				const job = jobs.get(target);
				if (!job) ctx.ui.notify(`No running job "${target}".`, "warning");
				else ctx.ui.notify(showJob(job, Math.min(count, MAX_TAIL_LINES)), "info");
				return;
			}
			if (sub !== "kill" || rest.length === 0 || (rest.includes("all") && rest.length > 1)) {
				ctx.ui.notify(USAGE, "warning");
				return;
			}
			const ids = rest[0] === "all" ? [...jobs.keys()] : [...new Set(rest)];
			const unknown = ids.filter((id) => !jobs.has(id));
			if (unknown.length > 0) ctx.ui.notify(`No running job ${unknown.map((id) => `"${id}"`).join(", ")}.`, "warning");
			const targets = ids.map((id) => jobs.get(id)).filter((j): j is Job => !!j);
			if (targets.length === 0) {
				if (unknown.length === 0) ctx.ui.notify("No running jobs.", "info");
				return;
			}
			const outcomes = await Promise.all(targets.map((job) => kill(job, "user")));
			const exited = targets.filter((_, i) => outcomes[i]);
			const waiting = targets.filter((_, i) => !outcomes[i]);
			if (exited.length > 0) ctx.ui.notify(`Killed ${exited.map((j) => j.id).join(", ")}`, "info");
			if (waiting.length > 0) {
				ctx.ui.notify(
					`Sent kill to ${waiting.map((j) => j.id).join(", ")}, but it did not exit within ${killWaitMs / 1000}s. ` +
						"It is listed as killing until it exits.",
					"warning",
				);
			}
		},
	});

	// Draw the completion as a finished `bash` tool row: pi's own ToolExecutionComponent with the bash
	// tool's renderers. Display extensions that restyle bash tool rows apply to it as well.
	// The "Job" label (used as the row title by display extensions) and the job suffix in pi's
	// default call line tell it apart from a foreground bash call. Created once so per-definition caches hit.
	const completionRow = {
		...bash,
		label: "Job",
		renderCall(rawArgs: unknown, theme: Theme, context: { lastComponent?: unknown }) {
			const args = rawArgs as { command: string; timeout?: number; job?: string };
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const timeout = args.timeout ? theme.fg("muted", ` (timeout ${args.timeout}s)`) : "";
			const job = args.job ? theme.fg("muted", ` · ${args.job}`) : "";
			text.setText(theme.fg("toolTitle", theme.bold(`$ ${args.command}`)) + timeout + job);
			return text;
		},
	} as unknown as ToolDefinition;
	pi.registerMessageRenderer<BashJobMessageDetails>(MESSAGE_TYPE, (message, { expanded, outputPad }) => {
		const d = message.details;
		if (!d) return undefined;
		const raw =
			typeof message.content === "string"
				? message.content
				: message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		// The model-facing content is "<header>\n\n<bash output>"; the row shows only the bash output.
		const output = outputOf(raw, d);
		const ui = tui ?? ({ requestRender() {} } as unknown as TUI);
		const row = new ToolExecutionComponent(
			"bash",
			`${MESSAGE_TYPE}:${d.id}`,
			{ command: d.command, timeout: d.timeout, job: d.id },
			{ outputPad },
			completionRow,
			ui,
			process.cwd(),
		);
		row.setArgsComplete();
		row.updateResult({
			content: [{ type: "text", text: output }],
			details: d.bashDetails,
			isError: d.status !== "done",
			durationMs: d.durationMs,
		});
		row.setExpanded(expanded);
		return row;
	});

	// Print and JSON mode (`pi -p`, `pi --mode json`) exit as soon as the run settles, and the
	// shutdown would kill running jobs before their results reach the model. Hold the run at its last
	// boundary until the jobs that report to the agent have finished: their steered completion
	// messages are queued, so pi continues the run with them instead of exiting.
	pi.on("agent_before_settle", async (_event, ctx) => {
		if (ctx.mode !== "print" && ctx.mode !== "json") return;
		// Killed jobs are recorded without waking the agent, so they need no continuation.
		const waiting = [...jobs.values()].filter((job) => !job.killedBy && !job.silenced);
		if (waiting.length === 0) return;
		await Promise.all(waiting.map((job) => job.reported));
	});

	pi.on("session_start", (_event, ctx) => {
		uiCtx = ctx;
		// Tell the user up front when jobs are refused because `bash` is replaced.
		if (ctx.hasUI) {
			try {
				const replacedBy = bashReplacement();
				if (replacedBy) {
					ctx.ui.notify(
						`pi-bash-jobs: the job tool is disabled because the bash tool is replaced by ${replacedBy}; jobs would run outside it.`,
						"warning",
					);
				}
			} catch {
				// The job tool reports the failure when it is called.
			}
		}
		// Each runtime (after reload, resume, new or fork) starts with a fresh counter; continue after
		// the ids already in this branch so old and new jobs never share an id.
		seq = Math.max(seq, lastJobNumber(ctx.sessionManager.getBranch()));
		if (ctx.mode === "tui") {
			// The widget factory runs synchronously and receives the TUI; remove the widget right away.
			ctx.ui.setWidget(TUI_CAPTURE_KEY, (t) => {
				tui = t;
				return { render: () => [], invalidate() {} };
			});
			ctx.ui.setWidget(TUI_CAPTURE_KEY, undefined);
		}
		updateStatus();
	});

	pi.on("session_shutdown", async (event) => {
		const running = [...jobs.values()];
		for (const job of running) {
			// The shutdown record below replaces the completion message.
			job.silenced = true;
			job.controller.abort();
		}
		// Wait (bounded) for the processes to exit, so the record has their output and the next
		// runtime does not start while they are still being torn down.
		const outcomes = new Map<Job, JobOutcome>();
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([
			Promise.all(running.map((job) => job.done.then((outcome) => void outcomes.set(job, outcome)))),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, killWaitMs);
			}),
		]);
		clearTimeout(timer);
		for (const job of running) recordInterrupted(job, outcomes.get(job), event.reason);
		jobs.clear();
		updateStatus();
		uiCtx = undefined;
		tui = undefined;
	});

	/** Record in the conversation that the session ended before the job finished. */
	function recordInterrupted(job: Job, outcome: JobOutcome | undefined, reason: SessionShutdownEvent["reason"]) {
		const durationMs = outcome?.durationMs ?? Date.now() - job.startedAt;
		const header = `Background job ${job.id} was interrupted after ${formatDuration(durationMs)} because ${SHUTDOWN_REASONS[reason] ?? "the session ended"}: ${summarizeCommand(job.command)}`;
		const latest = latestText(job);
		const text = outcome
			? outcome.text
			: `${latest || "(no output)"}\n\nThe process did not exit within ${killWaitMs / 1000}s of the kill and may still be running.`;
		const latestDetails = job.latest?.details;
		const details: BashJobMessageDetails = {
			id: job.id,
			command: job.command,
			timeout: job.timeout,
			status: "killed",
			reason: "interrupted",
			durationMs,
			bashDetails: outcome ? outcome.bashDetails : latestDetails?.truncation ? latestDetails : undefined,
		};
		try {
			// The session is idle during shutdown, so the message is appended right away, to the session
			// that ran the job (also when it is being replaced).
			pi.sendMessage<BashJobMessageDetails>(
				{ customType: MESSAGE_TYPE, content: `${header}\n\n${text}`, display: true, details },
				{ triggerTurn: false },
			);
		} catch {
			// Best effort: the runtime may already be unusable.
		}
	}
}

const SHUTDOWN_REASONS: Record<SessionShutdownEvent["reason"], string> = {
	quit: "pi exited",
	reload: "the session was reloaded",
	new: "a new session was started",
	resume: "another session was resumed",
	fork: "the session was forked",
};

/** The highest `job-N` number in the branch, from `job` and `kill_job` results and job messages. */
function lastJobNumber(entries: readonly SessionEntry[]): number {
	let max = 0;
	for (const entry of entries) {
		let details: unknown;
		if (entry.type === "custom_message" && entry.customType === MESSAGE_TYPE) details = entry.details;
		else if (entry.type === "message" && entry.message.role === "toolResult" && JOB_TOOLS.has(entry.message.toolName)) {
			details = entry.message.details;
		}
		const id = (details as { id?: unknown } | undefined)?.id;
		const n = typeof id === "string" ? /^job-(\d+)$/.exec(id)?.[1] : undefined;
		if (n) max = Math.max(max, Number(n));
	}
	return max;
}

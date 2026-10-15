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
import { Type } from "typebox";

const MESSAGE_TYPE = "bash-jobs";
const STATUS_KEY = "bash-jobs";
const TUI_CAPTURE_KEY = "bash-jobs:tui";
const KILL_WAIT_MS = 5_000;
/** Tools whose results carry a job id in `details.id`. */
const JOB_TOOLS = new Set(["job", "kill_job"]);

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
	const bash = createBashTool(process.cwd());
	const jobs = new Map<string, Job>();
	let seq = 0;
	let uiCtx: ExtensionContext | undefined;
	/** The interactive TUI, captured so completion cards can repaint themselves like live tool rows. */
	let tui: TUI | undefined;

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

	const listRunning = () =>
		jobs.size === 0
			? "No running jobs."
			: [...jobs.values()]
					.map((j) => {
						const state = j.state === "killing" ? ", killing" : "";
						return `${j.id} (${formatDuration(Date.now() - j.startedAt)}${state}): ${summarizeCommand(j.command)}`;
					})
					.join("\n");

	async function run(job: Job, params: { command: string; timeout?: number }, ctx: ExtensionToolContext): Promise<JobOutcome> {
		// The bash tool sends its last snapshot (with truncation and the full output path) before it
		// throws on a timeout or abort, so keep it for the failure paths.
		const onUpdate = (partial: AgentToolResult<BashToolDetails | undefined>) => {
			job.latest = partial;
		};
		try {
			const result = await bash.execute(job.id, params, job.controller.signal, onUpdate, ctx);
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

	function start(params: { command: string; timeout?: number }, ctx: ExtensionToolContext): Job {
		const job = {
			id: `job-${++seq}`,
			command: params.command,
			timeout: params.timeout,
			startedAt: Date.now(),
			controller: new AbortController(),
			state: "running",
			killWaiters: 0,
		} as Job;
		job.done = run(job, params, ctx);
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
		description:
			"Start a bash command as a background job and return its job id immediately. " +
			"When the command finishes, its output (truncated like the bash tool) arrives as a message that interrupts your current work. " +
			"Use for long-running commands that finish on their own, such as builds and test suites. " +
			"Not for servers or watchers that never exit. Optionally provide a timeout in seconds.",
		promptSnippet: "Run a long bash command in the background; you are notified when it finishes",
		promptGuidelines: [
			"Use the job tool for builds, test suites and other slow commands, then keep working on something else; do not sleep or poll to wait for the job.",
			"Use kill_job to stop a background job you no longer need.",
		],
		parameters: bash.parameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			uiCtx = ctx;
			const job = start(params, ctx);
			return {
				content: [
					{
						type: "text",
						text: `Started background job ${job.id}: ${summarizeCommand(job.command)}\nA message will arrive when it finishes. Continue with other work.`,
					},
				],
				details: { id: job.id },
			};
		},
	});

	pi.registerTool({
		name: "kill_job",
		label: "Kill Job",
		description:
			"Kill a running background job started with the job tool (including its child processes) and return its output so far. " +
			`Waits up to ${killWaitMs / 1000}s for the job to exit; if it does not, the result is an error and the output is recorded in the conversation when it exits.`,
		parameters: Type.Object({
			id: Type.String({ description: "Job id returned by the job tool, e.g. job-1" }),
		}),
		async execute(_toolCallId, { id }, _signal, _onUpdate, ctx) {
			uiCtx = ctx;
			const job = jobs.get(id.trim());
			if (!job) throw new Error(`No running job "${id}".\nRunning jobs:\n${listRunning()}`);
			const outcome = await kill(job, "agent");
			if (!outcome) {
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
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: `${describeOutcome(job, outcome)}\n\n${outcome.text}` }],
				details: { id: job.id, exited: true, status: outcome.status, reason: outcome.reason, exitCode: outcome.exitCode },
			};
		},
	});

	pi.registerCommand("jobs", {
		description: "List background bash jobs, or kill one: /jobs [kill <id>|all]",
		getArgumentCompletions: (prefix) => {
			const items = [{ value: "kill all", label: "kill all" }, ...[...jobs.keys()].map((id) => ({ value: `kill ${id}`, label: `kill ${id}` }))];
			const matches = items.filter((i) => i.value.startsWith(prefix.trim()));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			uiCtx = ctx;
			const [sub, target] = args.trim().split(/\s+/);
			if (!sub || sub === "list") {
				ctx.ui.notify(listRunning(), "info");
				return;
			}
			if (sub !== "kill" || !target) {
				ctx.ui.notify("Usage: /jobs [kill <id>|all]", "warning");
				return;
			}
			const targets = target === "all" ? [...jobs.values()] : [jobs.get(target)].filter((j): j is Job => !!j);
			if (targets.length === 0) {
				ctx.ui.notify(`No running job "${target}".`, "warning");
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
		const latest = job.latest?.content.map((c) => (c.type === "text" ? c.text : "")).join("");
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

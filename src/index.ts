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

import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MESSAGE_TYPE = "bash-jobs";
const STATUS_KEY = "bash-jobs";
const KILL_WAIT_MS = 5_000;
const PREVIEW_LINES = 8;

type JobStatus = "done" | "failed" | "killed";

interface JobOutcome {
	status: JobStatus;
	exitCode?: number;
	text: string;
	durationMs: number;
	fullOutputPath?: string;
}

interface Job {
	id: string;
	command: string;
	startedAt: number;
	controller: AbortController;
	done: Promise<JobOutcome>;
	/** Who requested the kill. Agent kills are reported by the kill tool itself. */
	killedBy?: "agent" | "user";
	/** Suppress the completion message (session is shutting down). */
	silenced?: boolean;
}

export interface BashJobMessageDetails {
	id: string;
	command: string;
	status: JobStatus;
	exitCode?: number;
	durationMs: number;
	fullOutputPath?: string;
}

const formatDuration = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`);

function describeOutcome(job: Job, outcome: JobOutcome): string {
	const what =
		outcome.status === "done"
			? "finished"
			: outcome.status === "killed"
				? "was killed"
				: outcome.exitCode !== undefined
					? `failed (exit ${outcome.exitCode})`
					: "failed";
	return `Background job ${job.id} ${what} after ${formatDuration(outcome.durationMs)}: ${job.command}`;
}

export default function bashJobs(pi: ExtensionAPI) {
	const bash = createBashToolDefinition(process.cwd());
	const jobs = new Map<string, Job>();
	let seq = 0;
	let uiCtx: ExtensionContext | undefined;

	const safeUi = (fn: (ctx: ExtensionContext) => void) => {
		if (!uiCtx?.hasUI) return;
		try {
			fn(uiCtx);
		} catch {
			// The context can go stale after session replacement; UI hints are best effort.
		}
	};

	const updateStatus = () =>
		safeUi((ctx) => ctx.ui.setStatus(STATUS_KEY, jobs.size > 0 ? `bash jobs: ${jobs.size} running` : undefined));

	const listRunning = () =>
		jobs.size === 0
			? "No running jobs."
			: [...jobs.values()].map((j) => `${j.id} (${formatDuration(Date.now() - j.startedAt)}): ${j.command}`).join("\n");

	async function run(job: Job, params: { command: string; timeout?: number }, ctx: ExtensionToolContext): Promise<JobOutcome> {
		try {
			const result = await bash.execute(job.id, params, job.controller.signal, undefined, ctx);
			const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
			const exitCode = (result.structuredContent as { exit_code?: number } | undefined)?.exit_code;
			return {
				status: result.isError ? "failed" : "done",
				exitCode,
				text,
				durationMs: Date.now() - job.startedAt,
				fullOutputPath: result.details?.fullOutputPath,
			};
		} catch (err) {
			// Timeouts, aborts and spawn errors are thrown by the bash tool with the output tail in the message.
			return {
				status: job.controller.signal.aborted ? "killed" : "failed",
				text: err instanceof Error ? err.message : String(err),
				durationMs: Date.now() - job.startedAt,
			};
		}
	}

	function report(job: Job, outcome: JobOutcome) {
		if (job.silenced || job.killedBy === "agent") return;
		const header = describeOutcome(job, outcome);
		const details: BashJobMessageDetails = {
			id: job.id,
			command: job.command,
			status: outcome.status,
			exitCode: outcome.exitCode,
			durationMs: outcome.durationMs,
			fullOutputPath: outcome.fullOutputPath,
		};
		// A user kill is recorded for the agent's context without waking it up.
		const options = job.killedBy === "user" ? { triggerTurn: false } : { triggerTurn: true, deliverAs: "steer" as const };
		pi.sendMessage<BashJobMessageDetails>(
			{ customType: MESSAGE_TYPE, content: `${header}\n\n${outcome.text}`, display: true, details },
			options,
		);
		safeUi((ctx) => ctx.ui.notify(header, outcome.status === "done" ? "info" : "warning"));
	}

	function start(params: { command: string; timeout?: number }, ctx: ExtensionToolContext): Job {
		const job = {
			id: `job-${++seq}`,
			command: params.command,
			startedAt: Date.now(),
			controller: new AbortController(),
		} as Job;
		job.done = run(job, params, ctx);
		jobs.set(job.id, job);
		updateStatus();
		void job.done.then((outcome) => {
			jobs.delete(job.id);
			updateStatus();
			report(job, outcome);
		});
		return job;
	}

	async function kill(job: Job, by: "agent" | "user"): Promise<JobOutcome | undefined> {
		job.killedBy = by;
		job.controller.abort();
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<undefined>((resolve) => {
			timer = setTimeout(() => resolve(undefined), KILL_WAIT_MS);
		});
		try {
			return await Promise.race([job.done, timeout]);
		} finally {
			clearTimeout(timer);
		}
	}

	pi.registerTool({
		name: "bash_job",
		label: "Bash Job",
		description:
			"Start a bash command as a background job and return its job id immediately. " +
			"When the command finishes, its output (truncated like the bash tool) arrives as a message that interrupts your current work. " +
			"Use for long-running commands that finish on their own, such as builds and test suites. " +
			"Not for servers or watchers that never exit. Optionally provide a timeout in seconds.",
		promptSnippet: "Run a long bash command in the background; you are notified when it finishes",
		promptGuidelines: [
			"Use bash_job for builds, test suites and other slow commands, then keep working on something else; do not sleep or poll to wait for the job.",
			"Use bash_job_kill to stop a background job you no longer need.",
		],
		parameters: bash.parameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			uiCtx = ctx;
			const job = start(params, ctx);
			return {
				content: [
					{
						type: "text",
						text: `Started background job ${job.id}: ${job.command}\nA message will arrive when it finishes. Continue with other work.`,
					},
				],
				details: { id: job.id },
			};
		},
	});

	pi.registerTool({
		name: "bash_job_kill",
		label: "Bash Job Kill",
		description: "Kill a running background job started with bash_job (including its child processes) and return its output so far.",
		parameters: Type.Object({
			id: Type.String({ description: "Job id returned by bash_job, e.g. job-1" }),
		}),
		async execute(_toolCallId, { id }, _signal, _onUpdate, ctx) {
			uiCtx = ctx;
			const job = jobs.get(id.trim());
			if (!job) throw new Error(`No running job "${id}".\nRunning jobs:\n${listRunning()}`);
			const outcome = await kill(job, "agent");
			const text = outcome
				? `${describeOutcome(job, outcome)}\n\n${outcome.text}`
				: `Sent kill to ${job.id}, but it did not exit within ${KILL_WAIT_MS / 1000}s.`;
			return { content: [{ type: "text", text }], details: { id: job.id } };
		},
	});

	pi.registerCommand("bash-jobs", {
		description: "List background bash jobs, or kill one: /bash-jobs [kill <id>|all]",
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
				ctx.ui.notify("Usage: /bash-jobs [kill <id>|all]", "warning");
				return;
			}
			const targets = target === "all" ? [...jobs.values()] : [jobs.get(target)].filter((j): j is Job => !!j);
			if (targets.length === 0) {
				ctx.ui.notify(`No running job "${target}".`, "warning");
				return;
			}
			await Promise.all(targets.map((job) => kill(job, "user")));
			ctx.ui.notify(`Killed ${targets.map((j) => j.id).join(", ")}`, "info");
		},
	});

	pi.registerMessageRenderer<BashJobMessageDetails>(MESSAGE_TYPE, (message, { expanded, outputPad }, theme) => {
		const raw =
			typeof message.content === "string"
				? message.content
				: message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		const [header = "", ...rest] = raw.split("\n");
		const body = rest.join("\n").replace(/^\n+/, "").trimEnd();
		const status = message.details?.status ?? "done";
		const color = status === "done" ? "success" : status === "killed" ? "warning" : "error";

		let text = theme.fg(color, theme.bold(header));
		if (body) {
			const lines = body.split("\n");
			const shown = expanded ? lines : lines.slice(-PREVIEW_LINES);
			if (shown.length < lines.length) text += `\n${theme.fg("dim", `… ${lines.length - shown.length} more lines (expand to show)`)}`;
			text += `\n${theme.fg("toolOutput", shown.join("\n"))}`;
		}
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	pi.on("session_start", (_event, ctx) => {
		uiCtx = ctx;
		updateStatus();
	});

	pi.on("session_shutdown", () => {
		for (const job of jobs.values()) {
			job.silenced = true;
			job.controller.abort();
		}
		jobs.clear();
		updateStatus();
		uiCtx = undefined;
	});
}

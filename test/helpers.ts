/**
 * Test harness: a fake pi ExtensionAPI that records registrations, messages and UI calls, plus a
 * controllable fake bash tool for paths that real processes cannot reproduce reliably.
 */
import { createBashToolDefinition, type BashToolOptions } from "@earendil-works/pi-coding-agent";
import { createBashJobs, type BashJobMessageDetails, type BashJobsOptions, type BashToolFactory } from "../src/index.ts";

export interface Sent {
	message: { customType: string; content: string; display: boolean; details: BashJobMessageDetails };
	options: unknown;
}

/** Wait until `predicate` holds, polling with an upper bound instead of sleeping a fixed time. */
export async function waitFor<T>(predicate: () => T | undefined | false, what = "condition", timeoutMs = 15_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = predicate();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

/** Reject if `promise` does not settle within `timeoutMs`, so a stuck process fails the test instead of hanging it. */
export function within<T>(promise: Promise<T>, what: string, timeoutMs = 15_000): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Let pending promise callbacks (for example the completion report) run. */
export const flush = () => new Promise<void>((r) => setImmediate(r));

export interface SetupOptions extends BashJobsOptions {
	/** Overrides merged into the tool and command context. */
	ctx?: Record<string, unknown>;
	/** Make `pi.sendMessage` throw, as it does once the runtime is stale. */
	sendMessageThrows?: boolean;
	/** Effective settings returned by `pi.getSettings()`; a function is called each time. Omit for a pi without it. */
	settings?: Record<string, unknown> | (() => Record<string, unknown>);
	/** Tools returned by `pi.getAllTools()` (name and sourceInfo suffice); a function is called each time. Omit for a pi without it. */
	tools?: Array<Record<string, unknown>> | (() => Array<Record<string, unknown>>);
}

export function setup(options: SetupOptions = {}) {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const renderers = new Map<string, any>();
	const handlers = new Map<string, Function>();
	const sent: Sent[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses: Array<string | undefined> = [];
	const widgets: Array<{ key: string; factory: unknown }> = [];
	const pi = {
		registerTool: (t: any) => tools.set(t.name, t),
		registerCommand: (name: string, c: any) => commands.set(name, c),
		registerMessageRenderer: (type: string, r: any) => renderers.set(type, r),
		on: (name: string, fn: Function) => handlers.set(name, fn),
		...(options.settings
			? { getSettings: () => (typeof options.settings === "function" ? options.settings() : { ...options.settings }) }
			: {}),
		...(options.tools ? { getAllTools: () => (typeof options.tools === "function" ? options.tools() : options.tools) } : {}),
		sendMessage: (message: any, opts: unknown) => {
			if (options.sendMessageThrows) throw new Error("This extension runtime is stale");
			sent.push({ message, options: opts });
		},
	};
	createBashJobs(options)(pi as any);
	const ctx: any = {
		cwd: process.cwd(),
		mode: "print",
		hasUI: false,
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			setWidget: (key: string, factory: unknown) => widgets.push({ key, factory }),
		},
		sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined, getBranch: () => [] },
		...options.ctx,
	};
	const call = (name: string, args: unknown) => tools.get(name).execute("call-1", args, undefined, undefined, ctx);
	const command = (args: string) => commands.get("jobs").handler(args, ctx);
	const complete = (prefix: string) => commands.get("jobs").getArgumentCompletions(prefix);
	const emit = (name: string, event: unknown = {}) => handlers.get(name)!({ type: name, ...(event as object) }, ctx);
	/** The `index`-th message sent (0-based), waiting for it if needed. */
	const message = (index = 0) => waitFor(() => sent[index], `message #${index}`);
	return { ctx, tools, commands, renderers, handlers, sent, notifications, statuses, widgets, call, command, complete, emit, message };
}

export const text = (r: any) => r.content.map((c: any) => c.text).join("");

/** A tool result like the bash tool returns. */
export function bashResult(output: string, exitCode = 0) {
	return {
		content: [{ type: "text" as const, text: exitCode === 0 ? output : `${output}\n\nCommand exited with code ${exitCode}` }],
		details: undefined,
		structuredContent: { output, truncated: false, exit_code: exitCode, wall_time_seconds: 0 },
		...(exitCode === 0 ? {} : { isError: true }),
	};
}

export interface FakeBashCall {
	params: { command: string; timeout?: number };
	signal: AbortSignal;
	onUpdate: ((update: any) => void) | undefined;
	resolve(result: unknown): void;
	reject(error: unknown): void;
}

/**
 * A bash tool whose executions stay pending until the test settles them. By default an abort
 * rejects like the real tool (`Command aborted`); `ignoreAbort` simulates a process that does not exit.
 */
export function fakeBash(behavior: { ignoreAbort?: boolean } = {}) {
	const calls: FakeBashCall[] = [];
	const created: Array<{ cwd: string; options?: BashToolOptions }> = [];
	const factory: BashToolFactory = (cwd, options) => {
		created.push({ cwd, options });
		return {
			...createBashToolDefinition(cwd, options),
			execute: (_id: string, params: any, signal: AbortSignal | undefined, onUpdate: any) =>
				new Promise((resolve, reject) => {
					if (!behavior.ignoreAbort) signal?.addEventListener("abort", () => reject(new Error("Command aborted")), { once: true });
					calls.push({ params, signal: signal!, onUpdate, resolve, reject });
				}),
		} as unknown as ReturnType<BashToolFactory>;
	};
	return { factory, calls, created, call: (index = 0) => waitFor(() => calls[index], `bash call #${index}`) };
}

/** pi's real bash tool, with a promise per execution that settles when the process has exited. */
export function spyBash() {
	const settled: Array<Promise<void>> = [];
	const factory: BashToolFactory = (cwd, options) => {
		const real = createBashToolDefinition(cwd, options);
		return {
			...real,
			execute(...args: Parameters<typeof real.execute>) {
				const run = real.execute(...args);
				settled.push(run.then(() => {}, () => {}));
				return run;
			},
		};
	};
	return { factory, settled };
}

/** A path usable inside a bash command on every platform (Git Bash accepts forward slashes). */
export const bashPath = (path: string) => path.replace(/\\/g, "/");

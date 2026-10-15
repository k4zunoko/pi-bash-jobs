/** Security: refusing jobs when bash is replaced, annotations, and guarding job commands with a tool_call handler. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashJobs } from "../src/index.ts";
import { fauxAssistantMessage, fauxText, jobMessages, startPi, toolTurn } from "./e2e-harness.ts";
import { bashResult, fakeBash, flush, setup, text } from "./helpers.ts";

test("job and kill_job declare their annotations", () => {
	const { tools } = setup();
	assert.deepEqual(tools.get("job").annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
	assert.deepEqual(tools.get("kill_job").annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
});

test("a tool_call guard extended to job blocks the job before it starts (real session)", async (t) => {
	// The README's advice for permission gates: check `job` as well as `bash`.
	const gate = (pi: ExtensionAPI) => {
		pi.on("tool_call", (event) => {
			if (event.toolName !== "bash" && event.toolName !== "job") return undefined;
			return /\brm -rf\b/.test(String(event.input.command)) ? { block: true, reason: "Dangerous command blocked" } : undefined;
		});
	};
	const pi = await startPi({
		t,
		extension: (api) => {
			createBashJobs()(api);
			gate(api);
		},
	});
	pi.faux.setResponses([...toolTurn("job", { command: "rm -rf /tmp/pi-bash-jobs-never" }, "blocked"), fauxAssistantMessage(fauxText("unused"))]);
	await pi.session.prompt("clean up");
	const result = pi.session.messages.find((m: any) => m.role === "toolResult" && m.toolName === "job") as any;
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Dangerous command blocked/);
	assert.equal(jobMessages(pi.session.sessionManager.getBranch()).length, 0);
	await pi.dispose();
});

const builtinBash = { name: "bash", sourceInfo: { path: "builtin:bash", source: "builtin" } };
const replacedBash = { name: "bash", sourceInfo: { path: "/home/me/.pi/agent/extensions/sandbox/index.ts", source: "local" } };
const others = [
	{ name: "read", sourceInfo: { path: "builtin:read", source: "builtin" } },
	{ name: "job", sourceInfo: { path: "/pkg/pi-bash-jobs/src/index.ts", source: "git" } },
];

test("job refuses to start while an extension replaces bash", async () => {
	const bash = fakeBash();
	const { call, command, sent, notifications } = setup({ createBashTool: bash.factory, tools: [...others, replacedBash] });
	await assert.rejects(call("job", { command: "npm test" }), (err: Error) => {
		assert.equal(
			err.message,
			"The job tool is disabled: the bash tool is replaced by /home/me/.pi/agent/extensions/sandbox/index.ts " +
				"(for example to run commands in a sandbox or on another host). Jobs run pi's built-in bash on this machine " +
				"and would bypass that replacement, so no job was started. Run the command with the bash tool instead.",
		);
		return true;
	});
	await flush();
	// Nothing ran locally, nothing was reported, and no id was used.
	assert.equal(bash.calls.length, 0);
	assert.equal(sent.length, 0);
	await command("");
	assert.equal(notifications.at(-1)!.message, "No running jobs.");
});

test("job runs with the built-in bash, without a bash tool, and on a pi without getAllTools", async () => {
	for (const tools of [[...others, builtinBash], others, undefined]) {
		const bash = fakeBash();
		const { call } = setup({ createBashTool: bash.factory, tools });
		assert.match(text(await call("job", { command: "x" })), /^Started background job job-1:/);
		(await bash.call(0)).resolve(bashResult(""));
	}
});

test("the check runs at every start, so a later replacement is caught", async () => {
	const bash = fakeBash();
	let tools = [...others, builtinBash];
	const { call } = setup({ createBashTool: bash.factory, tools: () => tools });
	assert.match(text(await call("job", { command: "first" })), /^Started background job job-1:/);
	tools = [...others, replacedBash];
	await assert.rejects(call("job", { command: "second" }), /the bash tool is replaced by .*sandbox/);
	assert.equal(bash.calls.length, 1);
});

test("job refuses to start when the replacement check fails", async () => {
	const bash = fakeBash();
	const { call } = setup({
		createBashTool: bash.factory,
		tools: () => {
			throw new Error("runtime is stale");
		},
	});
	await assert.rejects(call("job", { command: "x" }), /^Error: Cannot check whether the bash tool is replaced, so no job was started: runtime is stale$/);
	assert.equal(bash.calls.length, 0);
});

test("session_start warns the user when bash is replaced", async () => {
	const replaced = setup({ tools: [...others, replacedBash], ctx: { hasUI: true } });
	await replaced.emit("session_start", { reason: "startup" });
	assert.deepEqual(replaced.notifications, [
		{
			message: "pi-bash-jobs: the job tool is disabled because the bash tool is replaced by /home/me/.pi/agent/extensions/sandbox/index.ts; jobs would run outside it.",
			level: "warning",
		},
	]);
	const builtin = setup({ tools: [...others, builtinBash], ctx: { hasUI: true } });
	await builtin.emit("session_start", { reason: "startup" });
	assert.deepEqual(builtin.notifications, []);
});

test("with a bash-replacing extension in a real session, the job is an error and nothing runs locally", async (t) => {
	// Like pi's sandbox example: an extension registers its own `bash` in place of the built-in one.
	let sandboxedCalls = 0;
	const sandbox = (pi: ExtensionAPI) => {
		const local = createBashToolDefinition(process.cwd());
		pi.registerTool({
			...local,
			label: "bash (sandboxed)",
			async execute(id, params, signal, onUpdate, ctx) {
				sandboxedCalls++;
				return local.execute(id, params, signal, onUpdate, ctx);
			},
		});
	};
	const pi = await startPi({
		t,
		extension: (api) => {
			createBashJobs()(api);
			sandbox(api);
		},
	});
	pi.faux.setResponses([...toolTurn("job", { command: "echo should-not-run" }, "refused"), fauxAssistantMessage(fauxText("unused"))]);
	await pi.session.prompt("run it in the background");
	const result = pi.session.messages.find((m: any) => m.role === "toolResult" && m.toolName === "job") as any;
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /^The job tool is disabled: the bash tool is replaced by /);
	assert.equal(jobMessages(pi.session.sessionManager.getBranch()).length, 0);
	assert.equal(sandboxedCalls, 0);

	// The model can still run the command through the (replaced) bash tool.
	pi.faux.setResponses(toolTurn("bash", { command: "echo via-sandbox" }, "done"));
	await pi.session.prompt("then run it with bash");
	assert.equal(sandboxedCalls, 1);
	await pi.dispose();
});

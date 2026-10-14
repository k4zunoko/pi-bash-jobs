/** Session lifecycle with a fake bash: job ids across runtimes, the bounded shutdown wait, report failures. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bashResult, fakeBash, flush, setup, text } from "./helpers.ts";

const branchWith = (...entries: unknown[]) => ({
	getSessionId: () => "test",
	getSessionFile: () => undefined,
	getBranch: () => entries,
});
const jobResult = (toolName: string, id: string) => ({
	type: "message",
	message: { role: "toolResult", toolName, toolCallId: `call-${id}`, content: [], details: { id }, isError: false },
});
const jobMessage = (id: string) => ({ type: "custom_message", customType: "bash-jobs", content: "", display: true, details: { id } });

test("session_start continues after the job ids already in the branch", async () => {
	const bash = fakeBash();
	const sessionManager = branchWith(
		jobResult("job", "job-3"),
		jobMessage("job-5"),
		jobResult("kill_job", "job-4"),
		// Other tools and malformed ids do not count.
		jobResult("bash", "job-99"),
		jobMessage("build-7"),
		{ type: "custom_message", customType: "other", content: "", display: true, details: { id: "job-42" } },
	);
	const { call, emit } = setup({ createBashTool: bash.factory, ctx: { sessionManager } });
	await emit("session_start", { reason: "reload" });
	assert.match(text(await call("job", { command: "x" })), /^Started background job job-6:/);
	assert.match(text(await call("job", { command: "y" })), /^Started background job job-7:/);
});

test("ids keep counting up within a runtime even when the branch has fewer", async () => {
	const bash = fakeBash();
	const { call, emit } = setup({ createBashTool: bash.factory });
	await call("job", { command: "x" });
	await call("job", { command: "y" });
	// For example after /tree moved to an earlier point: ids are never reused in one runtime.
	await emit("session_start", { reason: "startup" });
	assert.match(text(await call("job", { command: "z" })), /^Started background job job-3:/);
});

test("session_shutdown waits for the exit before it returns", async () => {
	const bash = fakeBash({ ignoreAbort: true });
	const { call, emit, sent } = setup({ createBashTool: bash.factory, killWaitMs: 5_000 });
	await call("job", { command: "slow to exit" });
	const run = await bash.call(0);
	let returned = false;
	const shutdown = Promise.resolve(emit("session_shutdown", { reason: "quit" })).then(() => (returned = true));
	await flush();
	assert.equal(run.signal.aborted, true);
	assert.equal(returned, false, "still waiting for the process");
	run.reject(new Error("last words\n\nCommand aborted"));
	await shutdown;
	assert.equal(sent.length, 1);
	assert.match(sent[0]!.message.content, /because pi exited: slow to exit\n\nlast words\n\nCommand aborted$/);
});

test("session_shutdown gives up after the wait and records the output so far", async () => {
	const bash = fakeBash({ ignoreAbort: true });
	const { call, emit, sent } = setup({ createBashTool: bash.factory, killWaitMs: 20 });
	await call("job", { command: "stuck" });
	const run = await bash.call(0);
	run.onUpdate?.({ content: [{ type: "text", text: "progress 40%" }], details: undefined });
	await emit("session_shutdown", { reason: "new" });
	assert.equal(sent.length, 1);
	assert.equal(sent[0]!.message.details.reason, "interrupted");
	assert.match(
		sent[0]!.message.content,
		/^Background job job-1 was interrupted after \d+\.\ds because a new session was started: stuck\n\nprogress 40%\n\nThe process did not exit within 0\.02s of the kill and may still be running\.$/,
	);
	// A late exit after the shutdown sends nothing more.
	run.resolve(bashResult("done"));
	await flush();
	assert.equal(sent.length, 1);
});

test("a failing sendMessage does not cause an unhandled rejection", async () => {
	const rejections: unknown[] = [];
	const onRejection = (reason: unknown) => rejections.push(reason);
	process.on("unhandledRejection", onRejection);
	try {
		const bash = fakeBash();
		const { call, statuses } = setup({ createBashTool: bash.factory, sendMessageThrows: true, ctx: { hasUI: true } });
		await call("job", { command: "x" });
		(await bash.call(0)).resolve(bashResult("out"));
		await flush();
		await flush();
		assert.deepEqual(rejections, []);
		assert.equal(statuses.at(-1), undefined, "the status is still cleared");
	} finally {
		process.off("unhandledRejection", onRejection);
	}
});

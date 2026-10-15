/**
 * Job control with a fake bash tool: paths that real processes cannot reproduce on demand
 * (a process that ignores the kill, a spawn failure, jobs finishing in a chosen order).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bashResult, fakeBash, flush, setup, text } from "./helpers.ts";

test("job returns while the command is still running", async () => {
	const bash = fakeBash();
	const { call, sent } = setup({ createBashTool: bash.factory });
	const r = await call("job", { command: "make build" });
	assert.match(text(r), /^Started background job job-1: make build\nA message will arrive when it finishes/);
	const run = await bash.call(0);
	assert.deepEqual(run.params, { command: "make build" });
	assert.equal(run.signal.aborted, false);
	assert.equal(sent.length, 0);
});

test("a spawn failure is reported as a failed job", async () => {
	const bash = fakeBash();
	const { call, message } = setup({ createBashTool: bash.factory });
	await call("job", { command: "echo hi" });
	(await bash.call(0)).reject(new Error("spawn /bin/bash ENOENT"));
	const { message: m, options } = await message(0);
	assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
	assert.equal(m.details.status, "failed");
	assert.equal(m.details.exitCode, undefined);
	assert.match(m.content, /^Background job job-1 failed after \d+\.\ds: echo hi\n\nspawn \/bin\/bash ENOENT$/);
});

test("concurrent jobs get their own ids and messages, in completion order", async () => {
	const bash = fakeBash();
	const { call, message, statuses } = setup({ createBashTool: bash.factory, ctx: { hasUI: true } });
	await call("job", { command: "first" });
	await call("job", { command: "second" });
	assert.deepEqual(statuses, ["jobs: 1 running", "jobs: 2 running"]);

	(await bash.call(1)).resolve(bashResult("out-2"));
	const second = await message(0);
	assert.equal(second.message.details.id, "job-2");
	assert.match(second.message.content, /^Background job job-2 finished after .*: second\n\nout-2$/);
	assert.equal(statuses.at(-1), "jobs: 1 running");

	(await bash.call(0)).resolve(bashResult("out-1", 1));
	const first = await message(1);
	assert.equal(first.message.details.id, "job-1");
	assert.equal(first.message.details.status, "failed");
	assert.equal(first.message.details.exitCode, 1);
	assert.equal(statuses.at(-1), undefined);
});

test("the footer status is not touched without a UI", async () => {
	const bash = fakeBash();
	const { call, statuses } = setup({ createBashTool: bash.factory, ctx: { hasUI: false } });
	await call("job", { command: "x" });
	(await bash.call(0)).resolve(bashResult(""));
	await flush();
	assert.deepEqual(statuses, []);
});

test("kill_job with an unknown id lists the running jobs", async () => {
	const bash = fakeBash();
	const { call } = setup({ createBashTool: bash.factory });
	await call("job", { command: "npm test" });
	await assert.rejects(call("kill_job", { id: "job-9" }), (err: Error) => {
		assert.match(err.message, /^No running job "job-9"\.\nRunning jobs:\njob-1 \(\d+\.\ds\): npm test$/);
		return true;
	});
});

test("session_shutdown aborts every job and suppresses their messages", async () => {
	const bash = fakeBash();
	const { call, emit, sent, statuses } = setup({ createBashTool: bash.factory, ctx: { hasUI: true } });
	await call("job", { command: "a" });
	await call("job", { command: "b" });
	await emit("session_shutdown", { reason: "reload" });
	assert.equal((await bash.call(0)).signal.aborted, true);
	assert.equal((await bash.call(1)).signal.aborted, true);
	await flush();
	assert.equal(sent.length, 0);
	assert.equal(statuses.at(-1), undefined);
});

test("session_start captures the TUI only in TUI mode and refreshes the status", async () => {
	const tuiRun = setup({ ctx: { mode: "tui", hasUI: true } });
	await tuiRun.emit("session_start", { reason: "startup" });
	assert.equal(tuiRun.widgets.length, 2);
	assert.equal(tuiRun.widgets[0]!.key, "bash-jobs:tui");
	assert.equal(typeof tuiRun.widgets[0]!.factory, "function");
	assert.deepEqual(tuiRun.widgets[1], { key: "bash-jobs:tui", factory: undefined });
	// The factory hands back an empty component; the widget is removed right away.
	const component = (tuiRun.widgets[0]!.factory as Function)({ requestRender() {} }, {});
	assert.deepEqual(component.render(80), []);
	assert.deepEqual(tuiRun.statuses, [undefined]);

	const rpcRun = setup({ ctx: { mode: "rpc", hasUI: true } });
	await rpcRun.emit("session_start", { reason: "startup" });
	assert.equal(rpcRun.widgets.length, 0);
	assert.deepEqual(rpcRun.statuses, [undefined]);
});

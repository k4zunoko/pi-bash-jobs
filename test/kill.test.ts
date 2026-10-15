/** Kills that wait for the exit, and kills whose wait times out before the process exits. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bashResult, fakeBash, flush, setup, text } from "./helpers.ts";

const aborted = (output: string) => new Error(`${output}\n\nCommand aborted`);

test("kill_job returns the outcome when the job exits within the wait", async () => {
	const bash = fakeBash();
	const { call, sent } = setup({ createBashTool: bash.factory });
	await call("job", { command: "npm test" });
	const r = await call("kill_job", { id: "job-1" });
	assert.equal(r.isError, undefined);
	assert.deepEqual(r.details, { id: "job-1", exited: true, status: "killed", reason: "aborted", exitCode: undefined });
	assert.match(text(r), /^Background job job-1 was killed after \d+\.\ds: npm test\n\nCommand aborted$/);
	await flush();
	assert.equal(sent.length, 0);
});

test("a kill_job wait that times out is an error, and the late exit is recorded", async () => {
	const bash = fakeBash({ ignoreAbort: true });
	const { call, command, notifications, sent, statuses, message } = setup({
		createBashTool: bash.factory,
		killWaitMs: 20,
		ctx: { hasUI: true },
	});
	await call("job", { command: "stuck" });
	await call("job", { command: "other" });
	const run = await bash.call(0);
	const r = await call("kill_job", { id: "job-1" });
	assert.equal(run.signal.aborted, true);
	assert.equal(r.isError, true);
	assert.deepEqual(r.details, { id: "job-1", exited: false });
	assert.match(text(r), /^Sent kill to job-1, but it did not exit within 0\.02s\. It is listed as killing until it exits/);

	// Listed and counted as killing until the process exits.
	assert.equal(statuses.at(-1), "jobs: 1 running, 1 killing");
	await command("");
	assert.match(notifications.at(-1)!.message, /^job-1 \(\d+\.\ds, killing\): stuck\njob-2 \(\d+\.\ds\): other$/);
	assert.equal(sent.length, 0);

	run.reject(aborted("partial-output"));
	const { message: m, options } = await message(0);
	assert.deepEqual(options, { triggerTurn: false });
	assert.equal(m.details.id, "job-1");
	assert.equal(m.details.status, "killed");
	assert.match(m.content, /^Background job job-1 was killed after \d+\.\ds \(exited \d+\.\ds after the kill request\): stuck\n\npartial-output\n\nCommand aborted$/);
	assert.equal(statuses.at(-1), "jobs: 1 running");
	await assert.rejects(call("kill_job", { id: "job-1" }), /No running job "job-1"/);
});

test("a second kill_job that sees the exit reports it once, in its result", async () => {
	const bash = fakeBash({ ignoreAbort: true });
	const { call, sent } = setup({ createBashTool: bash.factory, killWaitMs: 50 });
	await call("job", { command: "stuck" });
	const run = await bash.call(0);
	const first = await call("kill_job", { id: "job-1" });
	assert.equal(first.details.exited, false);

	const second = call("kill_job", { id: "job-1" });
	run.reject(aborted("done-now"));
	const r = await second;
	assert.equal(r.isError, undefined);
	assert.equal(r.details.exited, true);
	assert.match(text(r), /^Background job job-1 was killed after .* \(exited .* after the kill request\): stuck\n\ndone-now/);
	await flush();
	assert.equal(sent.length, 0);
});

test("/jobs kill tells exited jobs from jobs still exiting", async () => {
	const bash = fakeBash({ ignoreAbort: true });
	const { call, command, notifications, sent, message } = setup({ createBashTool: bash.factory, killWaitMs: 20 });
	await call("job", { command: "quick" });
	await call("job", { command: "stuck" });
	const quick = await bash.call(0);
	const stuck = await bash.call(1);
	quick.signal.addEventListener("abort", () => quick.reject(aborted("quick-out")));
	await command("kill all");
	assert.deepEqual(notifications, [
		{ message: "Killed job-1", level: "info" },
		{ message: "Sent kill to job-2, but it did not exit within 0.02s. It is listed as killing until it exits.", level: "warning" },
	]);
	assert.equal(sent.length, 1);
	assert.equal(sent[0]!.message.details.id, "job-1");

	stuck.reject(aborted("stuck-out"));
	const { message: m, options } = await message(1);
	assert.deepEqual(options, { triggerTurn: false });
	assert.match(m.content, /^Background job job-2 was killed after .* \(exited .* after the kill request\): stuck\n\nstuck-out/);
});

test("a job that exits normally right after a timed-out kill is still recorded", async () => {
	const bash = fakeBash({ ignoreAbort: true });
	const { call, message } = setup({ createBashTool: bash.factory, killWaitMs: 20 });
	await call("job", { command: "stuck" });
	const run = await bash.call(0);
	await call("kill_job", { id: "job-1" });
	run.resolve(bashResult("finished anyway"));
	const { message: m, options } = await message(0);
	assert.deepEqual(options, { triggerTurn: false });
	assert.equal(m.details.status, "done");
	assert.match(m.content, /finished anyway$/);
});

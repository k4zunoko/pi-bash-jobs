/** Print and JSON mode: the run waits at agent_before_settle for jobs that report to the agent. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bashResult, fakeBash, flush, setup } from "./helpers.ts";

for (const mode of ["print", "json"]) {
	test(`${mode} mode: agent_before_settle waits until the job's completion is steered`, async () => {
		const bash = fakeBash();
		const { call, emit, sent } = setup({ createBashTool: bash.factory, ctx: { mode } });
		await call("job", { command: "npm test" });
		let settled = false;
		const boundary = Promise.resolve(emit("agent_before_settle", { entries: [], continue: false })).then((result) => {
			settled = true;
			return result;
		});
		await flush();
		assert.equal(settled, false, "the run waits for the job");
		(await bash.call(0)).resolve(bashResult("all green"));
		// No entries or continue flag: the steered message is queued, and pi continues the run with it.
		assert.equal(await boundary, undefined);
		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0]!.options, { triggerTurn: true, deliverAs: "steer" });
	});
}

for (const mode of ["tui", "rpc"]) {
	test(`${mode} mode: agent_before_settle does not wait`, async () => {
		const bash = fakeBash();
		const { call, emit, sent } = setup({ createBashTool: bash.factory, ctx: { mode } });
		await call("job", { command: "npm test" });
		assert.equal(await emit("agent_before_settle", { entries: [], continue: false }), undefined);
		assert.equal(sent.length, 0);
	});
}

test("print mode: killed jobs and finished runs need no wait", async () => {
	const bash = fakeBash({ ignoreAbort: true });
	const { call, emit } = setup({ createBashTool: bash.factory, killWaitMs: 20, ctx: { mode: "print" } });
	assert.equal(await emit("agent_before_settle", { entries: [], continue: false }), undefined);
	await call("job", { command: "stuck" });
	// The kill gives up waiting; the late exit is recorded without waking the agent.
	await call("kill_job", { id: "job-1" });
	assert.equal(await emit("agent_before_settle", { entries: [], continue: false }), undefined);
});

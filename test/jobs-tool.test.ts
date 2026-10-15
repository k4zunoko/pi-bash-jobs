/** The read-only `jobs` tool: list running jobs and show the latest output of one. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { fakeBash, setup, text } from "./helpers.ts";

test("jobs lists running jobs with structured content", async () => {
	const bash = fakeBash({ ignoreAbort: true });
	const { tools, call } = setup({ createBashTool: bash.factory, killWaitMs: 20 });
	const empty = await call("jobs", {});
	assert.equal(text(empty), "No running jobs.");
	assert.deepEqual(empty.structuredContent, { jobs: [] });

	await call("job", { command: "npm test", timeout: 600 });
	await call("job", { command: "make\nmake install" });
	await call("kill_job", { id: "job-2" });
	const r = await call("jobs", {});
	assert.match(text(r), /^job-1 \(\d+\.\ds\): npm test\njob-2 \(\d+\.\ds, killing\): make ⏎ make install$/);
	const { jobs } = r.structuredContent;
	assert.deepEqual(
		jobs.map((j: any) => [j.id, j.command, j.state, j.timeout, typeof j.elapsed_seconds]),
		[
			["job-1", "npm test", "running", 600, "number"],
			["job-2", "make\nmake install", "killing", undefined, "number"],
		],
	);
	assert.ok(!("timeout" in jobs[1]));
	assert.ok(Value.Check(tools.get("jobs").outputSchema, r.structuredContent));
});

test("jobs with an id shows the last lines of its output so far", async () => {
	const bash = fakeBash();
	const { tools, call } = setup({ createBashTool: bash.factory });
	await call("job", { command: "npm test" });
	const run = await bash.call(0);
	const before = await call("jobs", { id: "job-1" });
	assert.match(text(before), /^job-1 \(\d+\.\ds\): npm test\nNo output yet\.$/);
	assert.equal(before.structuredContent.output, "");

	run.onUpdate!({ content: [{ type: "text", text: "a\nb\nc\nd\n" }], details: undefined });
	const r = await call("jobs", { id: " job-1 ", tail: 2 });
	assert.match(text(r), /^job-1 \(\d+\.\ds\): npm test\nOutput so far \(last 2 lines\):\nc\nd$/);
	assert.equal(r.structuredContent.output, "c\nd");
	assert.ok(Value.Check(tools.get("jobs").outputSchema, r.structuredContent));
	assert.equal((await call("jobs", { id: "job-1" })).structuredContent.output, "a\nb\nc\nd");
	// Reading does not affect the job.
	assert.equal(run.signal.aborted, false);
});

test("jobs with an unknown id is an error that lists the running jobs", async () => {
	const bash = fakeBash();
	const { call } = setup({ createBashTool: bash.factory });
	await call("job", { command: "npm test" });
	await assert.rejects(call("jobs", { id: "job-4" }), /^Error: No running job "job-4"\.\nRunning jobs:\njob-1 /);
});

test("jobs is declared read-only, bounds tail, and tells the model not to poll", () => {
	const { tools } = setup();
	const tool = tools.get("jobs");
	assert.deepEqual(tool.annotations, { readOnlyHint: true, openWorldHint: false });
	assert.equal(tool.parameters.properties.tail.maximum, 500);
	assert.ok(tool.promptGuidelines.some((g: string) => /not to poll/.test(g)));
});

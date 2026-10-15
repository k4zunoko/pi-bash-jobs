/** Validation before a job starts, and structured results for programmatic callers. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import { bashResult, fakeBash, flush, setup, text } from "./helpers.ts";

test("job rejects an invalid timeout without starting a job", async () => {
	const bash = fakeBash();
	const { call, sent } = setup({ createBashTool: bash.factory });
	await assert.rejects(call("job", { command: "x", timeout: -1 }), /^Error: Invalid timeout: must be a finite number of seconds$/);
	await assert.rejects(call("job", { command: "x", timeout: 0 }), /Invalid timeout: must be a finite number of seconds/);
	await assert.rejects(call("job", { command: "x", timeout: Number.NaN }), /Invalid timeout: must be a finite number of seconds/);
	await assert.rejects(call("job", { command: "x", timeout: 3_000_000 }), /Invalid timeout: maximum is 2147483.647 seconds/);
	await flush();
	assert.equal(bash.calls.length, 0);
	assert.equal(sent.length, 0);
	// No id was used up.
	assert.match(text(await call("job", { command: "x", timeout: 2_147_483 })), /^Started background job job-1:/);
});

test("job rejects a missing working directory without starting a job", async () => {
	const missing = join(tmpdir(), "pi-bash-jobs-missing-dir");
	assert.ok(!existsSync(missing));
	const bash = fakeBash();
	const { call, command, sent, notifications } = setup({ createBashTool: bash.factory, ctx: { cwd: missing } });
	await assert.rejects(call("job", { command: "echo never" }), /Working directory does not exist: .*pi-bash-jobs-missing-dir/);
	await flush();
	assert.equal(bash.calls.length, 0);
	assert.equal(sent.length, 0);
	await command("");
	assert.equal(notifications.at(-1)!.message, "No running jobs.");
});

test("job returns structured content that matches its output schema", async () => {
	const bash = fakeBash();
	const { tools, call } = setup({ createBashTool: bash.factory });
	const r = await call("job", { command: "npm test\nnpm run lint" });
	assert.deepEqual(r.structuredContent, { id: "job-1", command: "npm test\nnpm run lint" });
	assert.ok(Value.Check(tools.get("job").outputSchema, r.structuredContent));
});

test("kill_job returns structured content when the job exits", async () => {
	const bash = fakeBash();
	const { tools, call } = setup({ createBashTool: bash.factory });
	await call("job", { command: "npm test" });
	const r = await call("kill_job", { id: "job-1" });
	assert.deepEqual(r.structuredContent, { id: "job-1", exited: true, status: "killed", output: "Command aborted" });
	assert.ok(Value.Check(tools.get("kill_job").outputSchema, r.structuredContent));
});

test("kill_job structured content carries the exit code when the job exited on its own", async () => {
	const bash = fakeBash({ ignoreAbort: true });
	const { tools, call } = setup({ createBashTool: bash.factory, killWaitMs: 1_000 });
	await call("job", { command: "exit 4" });
	const run = await bash.call(0);
	const killing = call("kill_job", { id: "job-1" });
	run.resolve(bashResult("bye", 4));
	const r = await killing;
	assert.deepEqual(r.structuredContent, { id: "job-1", exited: true, status: "failed", exit_code: 4, output: "bye\n\nCommand exited with code 4" });
	assert.ok(Value.Check(tools.get("kill_job").outputSchema, r.structuredContent));
});

test("kill_job structured content reports a job that is still exiting", async () => {
	const bash = fakeBash({ ignoreAbort: true });
	const { tools, call } = setup({ createBashTool: bash.factory, killWaitMs: 20 });
	await call("job", { command: "stuck" });
	(await bash.call(0)).onUpdate?.({ content: [{ type: "text", text: "50%" }], details: undefined });
	const r = await call("kill_job", { id: "job-1" });
	assert.equal(r.isError, true);
	assert.deepEqual(r.structuredContent, { id: "job-1", exited: false, status: "killing", output: "50%" });
	assert.ok(Value.Check(tools.get("kill_job").outputSchema, r.structuredContent));
});

test("the prompt guidelines tell the model to end its turn and not to rerun jobs with bash", () => {
	const { tools } = setup();
	const guidelines: string[] = tools.get("job").promptGuidelines;
	assert.ok(guidelines.some((g) => /do not sleep or poll/.test(g)));
	assert.ok(guidelines.some((g) => /end your turn/.test(g)));
	assert.ok(guidelines.some((g) => /Do not run a command again with bash while it runs as a job/.test(g)));
	assert.ok(guidelines.some((g) => /kill_job/.test(g)));
});

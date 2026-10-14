/** The /jobs command: listing, killing, usage and argument completions. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeBash, setup } from "./helpers.ts";

test("/jobs lists nothing when no job runs", async () => {
	const { command, notifications } = setup();
	await command("");
	await command("list");
	assert.deepEqual(notifications, [
		{ message: "No running jobs.", level: "info" },
		{ message: "No running jobs.", level: "info" },
	]);
});

test("/jobs lists running jobs with their elapsed time and command", async () => {
	const bash = fakeBash();
	const { call, command, notifications } = setup({ createBashTool: bash.factory });
	await call("job", { command: "npm test" });
	await call("job", { command: "npm run build" });
	await command("");
	assert.equal(notifications.length, 1);
	assert.match(notifications[0]!.message, /^job-1 \(\d+\.\ds\): npm test\njob-2 \(\d+\.\ds\): npm run build$/);
});

test("/jobs kill <id> kills one job and records it without waking the agent", async () => {
	const bash = fakeBash();
	const { call, command, notifications, sent } = setup({ createBashTool: bash.factory });
	await call("job", { command: "first" });
	await call("job", { command: "second" });
	await command("kill job-2");
	assert.equal((await bash.call(0)).signal.aborted, false);
	assert.equal((await bash.call(1)).signal.aborted, true);
	assert.deepEqual(notifications, [{ message: "Killed job-2", level: "info" }]);
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0]!.options, { triggerTurn: false });
	assert.equal(sent[0]!.message.details.id, "job-2");
	assert.equal(sent[0]!.message.details.status, "killed");
	assert.match(sent[0]!.message.content, /^Background job job-2 was killed after .*: second\n\nCommand aborted$/);
});

test("/jobs kill all kills every job", async () => {
	const bash = fakeBash();
	const { call, command, notifications, sent } = setup({ createBashTool: bash.factory });
	await call("job", { command: "a" });
	await call("job", { command: "b" });
	await command("kill all");
	assert.deepEqual(notifications, [{ message: "Killed job-1, job-2", level: "info" }]);
	assert.deepEqual(
		sent.map((s) => [s.message.details.id, s.options]),
		[
			["job-1", { triggerTurn: false }],
			["job-2", { triggerTurn: false }],
		],
	);
});

test("/jobs warns about unknown jobs and bad arguments", async () => {
	const { command, notifications } = setup();
	await command("kill job-7");
	await command("kill");
	await command("stop job-1");
	assert.deepEqual(notifications, [
		{ message: 'No running job "job-7".', level: "warning" },
		{ message: "Usage: /jobs [kill <id>|all]", level: "warning" },
		{ message: "Usage: /jobs [kill <id>|all]", level: "warning" },
	]);
});

test("/jobs completes kill targets", async () => {
	const bash = fakeBash();
	const { call, complete } = setup({ createBashTool: bash.factory });
	await call("job", { command: "a" });
	const values = (prefix: string) => complete(prefix)?.map((i: { value: string }) => i.value) ?? null;
	assert.deepEqual(values(""), ["kill all", "kill job-1"]);
	assert.deepEqual(values("kill j"), ["kill job-1"]);
	assert.equal(values("x"), null);
});

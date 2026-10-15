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

const USAGE = "Usage: /jobs [list | show <id> [lines] | kill <id>... | kill all]";

test("/jobs warns about unknown jobs and bad arguments", async () => {
	const { command, notifications } = setup();
	await command("kill job-7");
	await command("kill");
	await command("stop job-1");
	await command("list extra");
	await command("show");
	await command("show job-1 0");
	await command("kill all job-1");
	await command("kill all");
	assert.deepEqual(notifications, [
		{ message: 'No running job "job-7".', level: "warning" },
		{ message: USAGE, level: "warning" },
		{ message: USAGE, level: "warning" },
		{ message: USAGE, level: "warning" },
		{ message: USAGE, level: "warning" },
		{ message: USAGE, level: "warning" },
		{ message: USAGE, level: "warning" },
		{ message: "No running jobs.", level: "info" },
	]);
});

test("/jobs kill accepts several ids and reports the unknown ones", async () => {
	const bash = fakeBash();
	const { call, command, notifications, sent } = setup({ createBashTool: bash.factory });
	await call("job", { command: "a" });
	await call("job", { command: "b" });
	await call("job", { command: "c" });
	await command("kill job-1 job-9 job-3 job-1");
	assert.equal((await bash.call(0)).signal.aborted, true);
	assert.equal((await bash.call(1)).signal.aborted, false);
	assert.equal((await bash.call(2)).signal.aborted, true);
	assert.deepEqual(notifications, [
		{ message: 'No running job "job-9".', level: "warning" },
		{ message: "Killed job-1, job-3", level: "info" },
	]);
	assert.deepEqual(
		sent.map((s) => s.message.details.id),
		["job-1", "job-3"],
	);
});

test("/jobs show prints the latest output of a running job", async () => {
	const bash = fakeBash();
	const { call, command, notifications } = setup({ createBashTool: bash.factory });
	await call("job", { command: "npm test" });
	await command("show job-1");
	assert.match(notifications.at(-1)!.message, /^job-1 \(\d+\.\ds\): npm test\nNo output yet\.$/);

	const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
	(await bash.call(0)).onUpdate!({
		content: [{ type: "text", text: `${lines}\n` }],
		details: { truncation: { truncated: true }, fullOutputPath: "/tmp/full.log" },
	});
	await command("show job-1");
	const shown = notifications.at(-1)!.message.split("\n");
	assert.equal(shown[1], "Output so far (last 20 lines):");
	assert.deepEqual(shown.slice(2, -1), Array.from({ length: 20 }, (_, i) => `line ${i + 11}`));
	assert.equal(shown.at(-1), "Full output so far: /tmp/full.log");

	await command("tail job-1 3");
	assert.deepEqual(notifications.at(-1)!.message.split("\n").slice(1, 5), ["Output so far (last 3 lines):", "line 28", "line 29", "line 30"]);
	await command("show job-2");
	assert.deepEqual(notifications.at(-1), { message: 'No running job "job-2".', level: "warning" });
});

test("/jobs completes subcommands and job ids", async () => {
	const bash = fakeBash();
	const { call, complete } = setup({ createBashTool: bash.factory });
	const values = (prefix: string) => complete(prefix)?.map((i: { value: string }) => i.value) ?? null;
	// Without jobs there is nothing to show or kill.
	assert.deepEqual(values(""), ["list"]);
	assert.deepEqual(values("l"), ["list"]);
	assert.equal(values("kill"), null);

	await call("job", { command: "a" });
	await call("job", { command: "b" });
	assert.deepEqual(values(""), ["list", "show job-1", "show job-2", "kill job-1", "kill job-2", "kill all"]);
	assert.deepEqual(values("s"), ["show job-1", "show job-2"]);
	assert.deepEqual(values("kill j"), ["kill job-1", "kill job-2"]);
	assert.deepEqual(values("kill a"), ["kill all"]);
	assert.equal(values("x"), null);
});

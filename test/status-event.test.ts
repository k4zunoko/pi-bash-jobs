/** The `bash-jobs:status` event on `pi.events`: the job counts other extensions can follow. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createBashJobs } from "../src/index.ts";
import { fauxAssistantMessage, fauxText, startPi, toolTurn } from "./e2e-harness.ts";
import { bashPath, bashResult, fakeBash, setup, waitFor } from "./helpers.ts";

const statusEvents = (events: Array<{ channel: string; data: unknown }>) =>
	events.filter((e) => e.channel === "bash-jobs:status").map((e) => e.data);

const aborted = () => new Error("Command aborted");

test("the counts are emitted in full at session start, job start, kill and end, without a UI", async () => {
	const bash = fakeBash();
	// The default context is print mode without a UI.
	const { call, command, emit, events, message, statuses } = setup({ createBashTool: bash.factory });
	await emit("session_start");
	assert.deepEqual(statusEvents(events), [{ waking: 0, killing: 0 }]);

	await call("job", { command: "a" });
	await call("job", { command: "b" });
	await command("kill job-1");
	(await bash.call(1)).resolve(bashResult("ok"));
	assert.deepEqual((await message(1)).options, { triggerTurn: true, deliverAs: "steer" });

	assert.deepEqual(statusEvents(events), [
		{ waking: 0, killing: 0 },
		{ waking: 1, killing: 0 },
		{ waking: 2, killing: 0 },
		{ waking: 1, killing: 1 },
		{ waking: 1, killing: 0 },
		{ waking: 0, killing: 0 },
	]);
	assert.deepEqual(statuses, [], "the footer status needs a UI; the event does not");
});

test("a job killed by the agent counts as killing until it exits, and its end does not wake the agent", async () => {
	const bash = fakeBash({ ignoreAbort: true });
	const { call, events, message } = setup({ createBashTool: bash.factory, killWaitMs: 20 });
	await call("job", { command: "stuck" });
	const run = await bash.call(0);
	await call("kill_job", { id: "job-1" });
	assert.deepEqual(statusEvents(events), [
		{ waking: 1, killing: 0 },
		{ waking: 0, killing: 1 },
	]);

	run.reject(aborted());
	assert.deepEqual((await message(0)).options, { triggerTurn: false });
	assert.deepEqual(statusEvents(events).at(-1), { waking: 0, killing: 0 });
});

test("session_shutdown: running jobs stop waking the agent at once, and the counts end at zero", async () => {
	const bash = fakeBash({ ignoreAbort: true });
	const { call, emit, events } = setup({ createBashTool: bash.factory, killWaitMs: 20 });
	await call("job", { command: "a" });
	await call("job", { command: "b" });
	await emit("session_shutdown", { reason: "quit" });
	assert.deepEqual(statusEvents(events), [
		{ waking: 1, killing: 0 },
		{ waking: 2, killing: 0 },
		{ waking: 0, killing: 2 },
		{ waking: 0, killing: 0 },
	]);
});

test("interactive mode: pi settles while a job runs, and the event says the job will wake it", async (t) => {
	const log: unknown[] = [];
	const pi = await startPi({
		extension: (api) => {
			createBashJobs()(api);
			api.events.on("bash-jobs:status", (data) => void log.push(data));
		},
		t,
		mode: "tui",
	});
	pi.session.subscribe((e) => {
		if (e.type === "agent_start" || e.type === "agent_settled") log.push(e.type);
	});
	// A job that runs until the test creates the `go` file (shell builtins only).
	const go = join(pi.dir, "go");
	t.after(() => writeFileSync(go, ""));
	const command = `while [ ! -f "${bashPath(go)}" ]; do :; done`;
	pi.faux.setResponses([...toolTurn("job", { command }, "Started."), fauxAssistantMessage(fauxText("Got it."))]);

	await pi.session.prompt("run it in the background");
	await waitFor(() => log.includes("agent_settled"), "pi to settle");
	assert.deepEqual(log, [{ waking: 0, killing: 0 }, "agent_start", { waking: 1, killing: 0 }, "agent_settled"]);

	writeFileSync(go, "");
	await waitFor(() => log.filter((e) => e === "agent_settled").length === 2, "the turn the job's end starts");
	// The count drops before the turn that the completion starts.
	assert.deepEqual(log.slice(4), [{ waking: 0, killing: 0 }, "agent_start", "agent_settled"]);

	await pi.dispose();
	assert.deepEqual(log.slice(7), [{ waking: 0, killing: 0 }, { waking: 0, killing: 0 }], "session_shutdown");
});

/** Session lifecycle through a real pi runtime: reload, quit and resume, and session replacement with running jobs. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createBashJobs } from "../src/index.ts";
import { fauxAssistantMessage, fauxText, jobMessages, startPi, toolResults, toolTurn } from "./e2e-harness.ts";
import { bashPath, waitFor } from "./helpers.ts";

const BUSY_LOOP = "while :; do :; done";

test("reload records the interrupted job once and continues the job ids", async (t) => {
	const pi = await startPi({ extension: createBashJobs(), t });
	const started = join(pi.dir, "started");
	pi.faux.setResponses(toolTurn("job", { command: `echo before-reload; : > "${bashPath(started)}"; ${BUSY_LOOP}` }));
	await pi.session.prompt("start a job");
	await waitFor(() => existsSync(started), "the job to start");

	await pi.session.reload();
	await pi.bind();
	const branch = () => pi.session.sessionManager.getBranch();
	const records = jobMessages(branch());
	assert.equal(records.length, 1);
	assert.equal(records[0]!.details.id, "job-1");
	assert.equal(records[0]!.details.status, "killed");
	assert.equal(records[0]!.details.reason, "interrupted");
	assert.match(records[0]!.content, /^Background job job-1 was interrupted after \d+\.\ds because the session was reloaded: echo before-reload; /);
	assert.match(records[0]!.content, /before-reload/);

	// The new runtime continues after job-1 instead of reusing it.
	pi.faux.setResponses([...toolTurn("job", { command: "echo after-reload" }), fauxAssistantMessage(fauxText("seen"))]);
	await pi.session.prompt("start another");
	assert.match(toolResults(branch(), "job").at(-1)!, /^Started background job job-2: echo after-reload/);
	await waitFor(() => jobMessages(branch()).length === 2, "the job-2 completion");
	assert.deepEqual(
		jobMessages(branch()).map((m) => [m.details.id, m.details.reason]),
		[
			["job-1", "interrupted"],
			["job-2", "exit"],
		],
	);
	await pi.dispose();
});

test("quitting records the job in the session file, and resuming it continues the ids", async (t) => {
	const first = await startPi({ extension: createBashJobs(), t });
	const started = join(first.dir, "started");
	first.faux.setResponses(toolTurn("job", { command: `: > "${bashPath(started)}"; ${BUSY_LOOP}` }));
	await first.session.prompt("start a job");
	await waitFor(() => existsSync(started), "the job to start");
	const sessionFile = first.session.sessionFile!;
	await first.dispose(); // quit

	// Like `pi --session <file>`: a new runtime (process) opens the stored session.
	const pi = await startPi({ extension: createBashJobs(), t, dir: first.dir, resume: sessionFile });
	const branch = () => pi.session.sessionManager.getBranch();
	const records = jobMessages(branch());
	assert.equal(records.length, 1);
	assert.equal(records[0]!.details.reason, "interrupted");
	assert.match(records[0]!.content, /^Background job job-1 was interrupted after \d+\.\ds because pi exited: /);

	pi.faux.setResponses([...toolTurn("job", { command: "echo resumed" }), fauxAssistantMessage(fauxText("seen"))]);
	await pi.session.prompt("start another");
	assert.match(toolResults(branch(), "job").at(-1)!, /^Started background job job-2: echo resumed/);
	await waitFor(() => jobMessages(branch()).length === 2, "the job-2 completion");
	await pi.dispose();
});

test("replacing the session records the job in the session that ran it", async (t) => {
	const pi = await startPi({ extension: createBashJobs(), t });
	const started = join(pi.dir, "started");
	pi.faux.setResponses(toolTurn("job", { command: `: > "${bashPath(started)}"; ${BUSY_LOOP}` }));
	await pi.session.prompt("start a job");
	await waitFor(() => existsSync(started), "the job to start");
	const sessionFile = pi.session.sessionFile!;

	await pi.runtime.newSession();
	await pi.bind();
	assert.equal(jobMessages(pi.session.sessionManager.getBranch()).length, 0, "nothing in the new session");
	await pi.runtime.switchSession(sessionFile);
	await pi.bind();
	const records = jobMessages(pi.session.sessionManager.getBranch());
	assert.equal(records.length, 1);
	assert.match(records[0]!.content, /^Background job job-1 was interrupted after .* because a new session was started: /);
	await pi.dispose();
});

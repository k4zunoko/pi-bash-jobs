/**
 * Integration tests with pi's real bash tool. Commands that are killed loop with shell builtins
 * only, so no child process (such as sleep.exe under Git Bash) is orphaned by the kill.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { bashPath, flush, setup, spyBash, text, waitFor, within } from "./helpers.ts";

const BUSY_LOOP = "while :; do :; done";
const marker = () => join(mkdtempSync(join(tmpdir(), "pi-bash-jobs-")), "started");

test("returns the job id and steers the completion message", async () => {
	const { call, message } = setup();
	const r = await call("job", { command: "echo hello-job" });
	assert.match(text(r), /^Started background job job-1: echo hello-job/);
	assert.deepEqual(r.details, { id: "job-1" });

	const { message: m, options } = await message(0);
	assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
	assert.equal(m.customType, "bash-jobs");
	assert.equal(m.display, true);
	assert.equal(m.details.id, "job-1");
	assert.equal(m.details.status, "done");
	assert.equal(m.details.exitCode, 0);
	assert.match(m.content, /^Background job job-1 finished after/);
	assert.match(m.content, /hello-job/);
});

test("reports a non-zero exit as failed", async () => {
	const { call, message } = setup();
	await call("job", { command: "echo oops; exit 3" });
	const { message: m } = await message(0);
	assert.equal(m.details.status, "failed");
	assert.equal(m.details.exitCode, 3);
	assert.match(m.content, /failed \(exit 3\)/);
	assert.match(m.content, /Command exited with code 3/);
});

test("reports a timeout as failed", async () => {
	const { call, message } = setup();
	await call("job", { command: BUSY_LOOP, timeout: 1 });
	const { message: m } = await message(0);
	assert.equal(m.details.status, "failed");
	assert.equal(m.details.timeout, 1);
	assert.match(m.content, /timed out after 1 seconds/);
});

test("reports an invalid timeout as a failed job", async () => {
	const { call, message } = setup();
	await call("job", { command: "echo never", timeout: -1 });
	const { message: m } = await message(0);
	assert.equal(m.details.status, "failed");
	assert.match(m.content, /Invalid timeout/);
});

test("reports a missing working directory as a failed job", async () => {
	const missing = join(tmpdir(), "pi-bash-jobs-missing-dir");
	assert.ok(!existsSync(missing));
	const { call, message } = setup({ ctx: { cwd: missing } });
	await call("job", { command: "echo never" });
	const { message: m } = await message(0);
	assert.equal(m.details.status, "failed");
	assert.match(m.content, /Working directory does not exist/);
});

test("kill_job stops the job and reports only in its result", async () => {
	const started = marker();
	const { call, sent } = setup();
	await call("job", { command: `echo before-kill; : > "${bashPath(started)}"; ${BUSY_LOOP}` });
	await waitFor(() => existsSync(started), "the job to start");
	const r = await call("kill_job", { id: "job-1" });
	assert.match(text(r), /^Background job job-1 was killed after/);
	assert.match(text(r), /before-kill/);
	assert.match(text(r), /Command aborted/);
	await flush();
	assert.equal(sent.length, 0);
	await assert.rejects(call("kill_job", { id: "job-1" }), /No running job "job-1"/);
});

test("session_shutdown kills running jobs without a message", async () => {
	const started = marker();
	const bash = spyBash();
	const { call, sent, emit } = setup({ createBashTool: bash.factory });
	await call("job", { command: `: > "${bashPath(started)}"; ${BUSY_LOOP}` });
	await waitFor(() => existsSync(started), "the job to start");
	await emit("session_shutdown", { reason: "quit" });
	// The bash tool settles only after the shell process has exited.
	await within(bash.settled[0]!, "the shell to exit");
	await flush();
	assert.equal(sent.length, 0);
});

test("renders the completion as a bash tool row", async () => {
	initTheme("dark");
	const { call, message, renderers } = setup();
	await call("job", { command: "echo render-me; exit 2" });
	const { message: m } = await message(0);
	const row = renderers.get("bash-jobs")(m, { expanded: false, outputPad: 1 });
	// eslint-disable-next-line no-control-regex
	const lines = row.render(80).map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
	assert.ok(lines.includes(" $ echo render-me; exit 2 · job-1"));
	assert.ok(lines.includes(" render-me"));
	assert.ok(lines.includes(" Command exited with code 2"));
	assert.ok(lines.some((l: string) => /^ Took \d/.test(l)));
	assert.ok(!lines.some((l: string) => l.includes("Background job")));
});

/** The shellPath and shellCommandPrefix settings apply to jobs as they do to the built-in bash tool. */
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBashJobs } from "../src/index.ts";
import { fauxAssistantMessage, fauxText, jobMessages, startPi, toolTurn } from "./e2e-harness.ts";
import { fakeBash, setup, text, waitFor } from "./helpers.ts";

test("each job creates its bash tool with the current shell settings and working directory", async () => {
	const bash = fakeBash();
	let settings: Record<string, unknown> = { shellPath: process.execPath, shellCommandPrefix: "shopt -s expand_aliases" };
	const { call } = setup({ createBashTool: bash.factory, settings: () => settings });
	await call("job", { command: "a" });
	// Settings changes apply to the next job without a reload.
	settings = { shellCommandPrefix: "source ~/.bashrc" };
	await call("job", { command: "b" });
	// created[0] is the definition used for parameters and rendering.
	assert.deepEqual(bash.created.slice(1), [
		{ cwd: process.cwd(), options: { shellPath: process.execPath, commandPrefix: "shopt -s expand_aliases" } },
		{ cwd: process.cwd(), options: { shellPath: undefined, commandPrefix: "source ~/.bashrc" } },
	]);
});

test("without pi.getSettings (older pi) jobs use pi's default shell", async () => {
	const bash = fakeBash();
	const { call } = setup({ createBashTool: bash.factory });
	await call("job", { command: "a" });
	assert.deepEqual(bash.created[1], { cwd: process.cwd(), options: { shellPath: undefined, commandPrefix: undefined } });
});

test("a shellPath that does not exist is an error result and starts no job", async () => {
	const missing = join(tmpdir(), "pi-bash-jobs-no-such-shell", "bash");
	const bash = fakeBash();
	const { call } = setup({ createBashTool: bash.factory, settings: { shellPath: missing } });
	await assert.rejects(call("job", { command: "a" }), (err: Error) => err.message === `Custom shell path not found: ${missing}`);
	assert.equal(bash.calls.length, 0);
	assert.match(text(await setup({ createBashTool: bash.factory }).call("job", { command: "a" })), /^Started background job job-1/);
});

test("shellCommandPrefix runs before the job's command (real bash)", async () => {
	const { call, message } = setup({ settings: { shellCommandPrefix: "export JOB_PREFIX=from-prefix\nalias greet='echo hi-alias'\nshopt -s expand_aliases" } });
	await call("job", { command: 'echo "$JOB_PREFIX"\ngreet' });
	const { message: m } = await message(0);
	assert.equal(m.details.status, "done");
	assert.match(m.content, /\n\nfrom-prefix\nhi-alias\n$/);
	// The header and details show the command as given, without the prefix.
	assert.equal(m.details.command, 'echo "$JOB_PREFIX"\ngreet');
});

const shIsDash = process.platform === "linux" && existsSync("/bin/sh") && realpathSync("/bin/sh").endsWith("dash");

test("shellPath selects the shell that runs the job (real shell)", { skip: !shIsDash && "needs /bin/sh to be dash" }, async () => {
	const { call, message } = setup({ settings: { shellPath: "/bin/sh" } });
	await call("job", { command: 'echo "bash=${BASH_VERSION:-none}"' });
	const { message: m } = await message(0);
	assert.match(m.content, /\n\nbash=none\n$/);
});

test("pi's settings reach the job through a real session (shellCommandPrefix)", async (t) => {
	const pi = await startPi({ extension: createBashJobs(), t, settings: { shellCommandPrefix: "export FROM_SETTINGS=yes" } });
	pi.faux.setResponses([...toolTurn("job", { command: 'echo "settings=$FROM_SETTINGS"' }), fauxAssistantMessage(fauxText("seen"))]);
	await pi.session.prompt("run");
	await waitFor(() => jobMessages(pi.session.sessionManager.getBranch()).length === 1, "the job message");
	assert.match(jobMessages(pi.session.sessionManager.getBranch())[0]!.content, /\n\nsettings=yes\n$/);
	await pi.dispose();
});

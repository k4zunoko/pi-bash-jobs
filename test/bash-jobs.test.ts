import assert from "node:assert/strict";
import { test } from "node:test";
import bashJobs, { type BashJobMessageDetails } from "../src/index.ts";

interface Sent {
	message: { customType: string; content: string; details: BashJobMessageDetails };
	options: unknown;
}

function setup() {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Function>();
	const sent: Sent[] = [];
	const waiters: Array<() => void> = [];
	const pi = {
		registerTool: (t: any) => tools.set(t.name, t),
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		on: (name: string, fn: Function) => handlers.set(name, fn),
		sendMessage: (message: any, options: unknown) => {
			sent.push({ message, options });
			waiters.splice(0).forEach((w) => w());
		},
	};
	bashJobs(pi as any);
	const ctx = {
		cwd: process.cwd(),
		hasUI: false,
		ui: { notify() {}, setStatus() {} },
		sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined },
	};
	const call = (name: string, args: unknown) => tools.get(name).execute("call-1", args, undefined, undefined, ctx);
	const nextMessage = () => new Promise<Sent>((resolve) => waiters.push(() => resolve(sent[sent.length - 1]!)));
	return { call, sent, nextMessage, handlers };
}

const text = (r: any) => r.content.map((c: any) => c.text).join("");

test("returns immediately and steers the completion message", async () => {
	const { call, nextMessage } = setup();
	const started = Date.now();
	const r = await call("bash_job", { command: "sleep 1; echo hello-job" });
	assert.ok(Date.now() - started < 900, "tool should not wait for the command");
	assert.match(text(r), /Started background job job-1/);

	const { message, options } = await nextMessage();
	assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
	assert.equal(message.customType, "bash-jobs");
	assert.equal(message.details.status, "done");
	assert.equal(message.details.exitCode, 0);
	assert.match(message.content, /^Background job job-1 finished after/);
	assert.match(message.content, /hello-job/);
});

test("reports a non-zero exit as failed", async () => {
	const { call, nextMessage } = setup();
	await call("bash_job", { command: "echo oops; exit 3" });
	const { message } = await nextMessage();
	assert.equal(message.details.status, "failed");
	assert.equal(message.details.exitCode, 3);
	assert.match(message.content, /failed \(exit 3\)/);
	assert.match(message.content, /Command exited with code 3/);
});

test("reports a timeout as failed", async () => {
	const { call, nextMessage } = setup();
	await call("bash_job", { command: "sleep 10", timeout: 1 });
	const { message } = await nextMessage();
	assert.equal(message.details.status, "failed");
	assert.match(message.content, /timed out after 1 seconds/);
});

test("bash_job_kill stops the job without a completion message", async () => {
	const { call, sent } = setup();
	await call("bash_job", { command: "echo before-kill; sleep 30" });
	await new Promise((r) => setTimeout(r, 500));
	const started = Date.now();
	const r = await call("bash_job_kill", { id: "job-1" });
	assert.ok(Date.now() - started < 5000);
	assert.match(text(r), /job-1 was killed/);
	assert.match(text(r), /before-kill/);
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(sent.length, 0);
	await assert.rejects(call("bash_job_kill", { id: "job-1" }), /No running job/);
});

test("session_shutdown aborts jobs silently", async () => {
	const { call, sent, handlers } = setup();
	await call("bash_job", { command: "sleep 30" });
	// Give Git Bash time to spawn the child; an immediate abort can orphan it on Windows (pi core behavior).
	await new Promise((r) => setTimeout(r, 500));
	handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" });
	await new Promise((r) => setTimeout(r, 1500));
	assert.equal(sent.length, 0);
});

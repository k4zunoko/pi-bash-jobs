/** Print and RPC mode through a real pi session runtime with a faux model. */
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createBashJobs } from "../src/index.ts";
import { fauxAssistantMessage, fauxText, jobMessages, startPi, toolTurn } from "./e2e-harness.ts";
import { bashPath, waitFor } from "./helpers.ts";

/** A job that runs until the test creates the `go` file (shell builtins only), then prints `from-job`. */
const gatedJob = (dir: string) => {
	const started = join(dir, "started");
	const go = join(dir, "go");
	return {
		command: `: > "${bashPath(started)}"; while [ ! -f "${bashPath(go)}" ]; do :; done; echo from-job`,
		started: () => existsSync(started),
		release: () => writeFileSync(go, ""),
	};
};

const lastAssistantText = (messages: readonly any[]) => {
	const last = messages.filter((m) => m.role === "assistant").at(-1);
	return last?.content.map((c: any) => (c.type === "text" ? c.text : "")).join("");
};

test("print mode: the job's result reaches the model before the prompt returns", async (t) => {
	const pi = await startPi({ extension: createBashJobs(), t, mode: "print" });
	const job = gatedJob(pi.dir);
	t.after(job.release);
	pi.faux.setResponses([
		...toolTurn("job", { command: job.command }, "Started; nothing else to do."),
		(context) => {
			const last = context.messages.at(-1) as any;
			const text = typeof last.content === "string" ? last.content : last.content.map((c: any) => c.text ?? "").join("");
			return fauxAssistantMessage(fauxText(`Saw: ${text.split("\n")[0]}`));
		},
	]);
	let returned = false;
	const prompt = pi.session.prompt("run the tests in the background").then(() => (returned = true));
	await waitFor(() => job.started() && pi.faux.state.callCount === 2, "the job to start and the turn to end");
	assert.equal(returned, false, "pi waits for the job instead of settling");

	job.release();
	await prompt;
	const records = jobMessages(pi.session.sessionManager.getBranch());
	assert.equal(records.length, 1);
	assert.match(records[0]!.content, /^Background job job-1 finished after .*\n\nfrom-job\n$/);
	assert.match(lastAssistantText(pi.session.messages), /^Saw: Background job job-1 finished after /);
	assert.equal(pi.faux.getPendingResponseCount(), 0);
	await pi.dispose();
});

test("rpc mode: the prompt returns right away and the result starts a new turn later", async (t) => {
	const pi = await startPi({ extension: createBashJobs(), t, mode: "rpc" });
	const job = gatedJob(pi.dir);
	t.after(job.release);
	pi.faux.setResponses([...toolTurn("job", { command: job.command }, "Started."), fauxAssistantMessage(fauxText("Got the result."))]);
	await pi.session.prompt("run the tests in the background");
	await waitFor(() => job.started(), "the job to start");
	assert.equal(jobMessages(pi.session.sessionManager.getBranch()).length, 0);

	job.release();
	await waitFor(() => pi.faux.getPendingResponseCount() === 0 && pi.session.isIdle, "the new turn");
	assert.equal(jobMessages(pi.session.sessionManager.getBranch()).length, 1);
	assert.equal(lastAssistantText(pi.session.messages), "Got the result.");
	await pi.dispose();
});

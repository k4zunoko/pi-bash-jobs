/** Security: annotations, and the documented way to guard job commands with a tool_call handler. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashJobs } from "../src/index.ts";
import { fauxAssistantMessage, fauxText, jobMessages, startPi, toolTurn } from "./e2e-harness.ts";
import { setup } from "./helpers.ts";

test("job and kill_job declare their annotations", () => {
	const { tools } = setup();
	assert.deepEqual(tools.get("job").annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
	assert.deepEqual(tools.get("kill_job").annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
});

test("a tool_call guard extended to job blocks the job before it starts (real session)", async (t) => {
	// The README's advice for permission gates: check `job` as well as `bash`.
	const gate = (pi: ExtensionAPI) => {
		pi.on("tool_call", (event) => {
			if (event.toolName !== "bash" && event.toolName !== "job") return undefined;
			return /\brm -rf\b/.test(String(event.input.command)) ? { block: true, reason: "Dangerous command blocked" } : undefined;
		});
	};
	const pi = await startPi({
		t,
		extension: (api) => {
			createBashJobs()(api);
			gate(api);
		},
	});
	pi.faux.setResponses([...toolTurn("job", { command: "rm -rf /tmp/pi-bash-jobs-never" }, "blocked"), fauxAssistantMessage(fauxText("unused"))]);
	await pi.session.prompt("clean up");
	const result = pi.session.messages.find((m: any) => m.role === "toolResult" && m.toolName === "job") as any;
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Dangerous command blocked/);
	assert.equal(jobMessages(pi.session.sessionManager.getBranch()).length, 0);
	await pi.dispose();
});

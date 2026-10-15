/** Completion message format: duration, command summary, end reason, truncation and old messages. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { formatDuration, summarizeCommand } from "../src/index.ts";
import { bashResult, fakeBash, setup, text } from "./helpers.ts";

// eslint-disable-next-line no-control-regex
const strip = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();

test("formatDuration carries over rounded seconds and shows hours", () => {
	const cases: Array<[number, string]> = [
		[0, "0.0s"],
		[940, "0.9s"],
		[59_940, "59.9s"],
		[59_960, "1m0s"],
		[61_000, "1m1s"],
		[119_600, "2m0s"],
		[3_599_400, "59m59s"],
		[3_599_700, "1h0m0s"],
		[3_725_000, "1h2m5s"],
		[7_200_000, "2h0m0s"],
	];
	for (const [ms, expected] of cases) assert.equal(formatDuration(ms), expected, `${ms} ms`);
});

test("summarizeCommand keeps one line and cuts long commands", () => {
	assert.equal(summarizeCommand("npm test"), "npm test");
	assert.equal(summarizeCommand("  cd app\n\n  npm test  \r\n"), "cd app ⏎ npm test");
	assert.equal(summarizeCommand("a\rb"), "a ⏎ b");
	const long = summarizeCommand("x".repeat(200));
	assert.equal(Array.from(long).length, 80);
	assert.ok(long.endsWith("…"));
	assert.equal(summarizeCommand("é".repeat(5), 4), "ééé…");
});

test("headers, the job list and the start result use one line per job", async () => {
	const bash = fakeBash();
	const { call, command, notifications, message } = setup({ createBashTool: bash.factory });
	const r = await call("job", { command: "cat <<EOF\nline one\n\nline two\nEOF" });
	assert.equal(text(r).split("\n")[0], "Started background job job-1: cat <<EOF ⏎ line one ⏎ line two ⏎ EOF");
	await call("job", { command: "for f in *; do\n  echo $f\ndone" });
	await command("");
	const lines = notifications[0]!.message.split("\n");
	assert.equal(lines.length, 2);
	assert.match(lines[0]!, /^job-1 \(\d+\.\ds\): cat <<EOF ⏎ line one ⏎ line two ⏎ EOF$/);
	assert.match(lines[1]!, /^job-2 \(\d+\.\ds\): for f in \*; do ⏎ echo \$f ⏎ done$/);

	(await bash.call(0)).resolve(bashResult("line one\n\nline two"));
	const { message: m } = await message(0);
	assert.equal(m.details.command, "cat <<EOF\nline one\n\nline two\nEOF");
	const [header, ...rest] = m.content.split("\n");
	assert.match(header!, /^Background job job-1 finished after \d+\.\ds: cat <<EOF ⏎ line one ⏎ line two ⏎ EOF$/);
	assert.equal(rest.join("\n"), "\nline one\n\nline two");
});

test("end reasons: exit, error and aborted", async () => {
	const bash = fakeBash();
	const { call, command, sent, message } = setup({ createBashTool: bash.factory });
	await call("job", { command: "ok" });
	await call("job", { command: "broken" });
	await call("job", { command: "long" });
	(await bash.call(0)).resolve(bashResult("fine"));
	(await bash.call(1)).reject(new Error("spawn bash ENOENT"));
	await message(1);
	await command("kill job-3");
	await message(2);
	assert.deepEqual(
		sent.map((s) => [s.message.details.id, s.message.details.status, s.message.details.reason]),
		[
			["job-1", "done", "exit"],
			["job-2", "failed", "error"],
			["job-3", "killed", "aborted"],
		],
	);
});

test("a killed job keeps the truncation details of its last output", async () => {
	initTheme("dark");
	const bash = fakeBash({ ignoreAbort: true });
	const { call, command, message, renderers } = setup({ createBashTool: bash.factory, killWaitMs: 1_000 });
	await call("job", { command: "seq 3000" });
	const run = await bash.call(0);
	const truncation = {
		content: "",
		truncated: true,
		truncatedBy: "lines",
		totalLines: 3000,
		totalBytes: 13893,
		outputLines: 2000,
		outputBytes: 9893,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines: 2000,
		maxBytes: 51200,
	};
	const details = { truncation, fullOutputPath: "/tmp/pi-bash-full.log" };
	run.onUpdate!({ content: [{ type: "text", text: "1001\n...\n3000" }], details });
	run.signal.addEventListener("abort", () =>
		run.reject(new Error("1001\n...\n3000\n\n[Showing lines 1001-3000 of 3000. Full output: /tmp/pi-bash-full.log]\n\nCommand aborted")),
	);
	await command("kill job-1");
	const { message: m } = await message(0);
	assert.equal(m.details.reason, "aborted");
	assert.deepEqual(m.details.bashDetails, details);
	const rendered = renderers.get("bash-jobs")(m, { expanded: false, outputPad: 1 }).render(200).map(strip).join("\n");
	assert.ok(rendered.includes("[Full output: /tmp/pi-bash-full.log. Truncated: showing 2000 of 3000 lines]"), rendered);
});

test("a failure without truncation has no bash details", async () => {
	const bash = fakeBash();
	const { call, message } = setup({ createBashTool: bash.factory });
	await call("job", { command: "x" });
	const run = await bash.call(0);
	run.onUpdate!({ content: [{ type: "text", text: "partial" }], details: { truncation: undefined, fullOutputPath: undefined } });
	run.reject(new Error("partial\n\nCommand timed out after 1 seconds"));
	const { message: m } = await message(0);
	// No timeout was given, so a message that looks like one is still an error.
	assert.equal(m.details.reason, "error");
	assert.equal(m.details.bashDetails, undefined);
});

test("renders messages stored by 0.2.0, whose header ends with the full command", () => {
	initTheme("dark");
	const { renderers } = setup();
	const command = "echo first\n\necho second";
	const legacy = {
		customType: "bash-jobs",
		content: `Background job job-1 finished after 0.3s: ${command}\n\nfirst\nsecond`,
		display: true,
		details: { id: "job-1", command, status: "done", exitCode: 0, durationMs: 300 },
	};
	const lines: string[] = renderers.get("bash-jobs")(legacy, { expanded: true, outputPad: 1 }).render(80).map(strip);
	const dump = lines.join("\n");
	assert.equal(lines.filter((l) => l.includes("echo second")).length, 1, dump);
	assert.ok(lines.includes(" first"), dump);
	assert.ok(lines.includes(" second"), dump);
	assert.ok(lines.includes(" Took 0.3s"), dump);

	const single = { ...legacy, content: "Background job job-2 finished after 0.1s: echo hi\n\nhi", details: { ...legacy.details, id: "job-2", command: "echo hi" } };
	const singleLines: string[] = renderers.get("bash-jobs")(single, { expanded: true, outputPad: 1 }).render(80).map(strip);
	assert.ok(singleLines.includes(" $ echo hi · job-2"));
	assert.ok(singleLines.includes(" hi"));
});

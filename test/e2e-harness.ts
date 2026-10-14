/**
 * End-to-end harness: a real pi session runtime (AgentSessionRuntime) with the extension loaded and
 * a scripted faux model, so reload, resume and print-mode behavior run through pi's own code.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type ExtensionFactory,
	ModelRuntime,
	type SessionEntry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { BashJobMessageDetails } from "../src/index.ts";

export { fauxAssistantMessage, fauxText, fauxToolCall };

/** The model calls `name` with `args`, then ends its turn with `reply`. */
export const toolTurn = (name: string, args: Parameters<typeof fauxToolCall>[1], reply = "ok"): FauxResponseStep[] => [
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
	fauxAssistantMessage(fauxText(reply)),
];

type ExtensionMode = "tui" | "rpc" | "json" | "print";

/** Start pi with the extension. Pass `resume` (a session file) to continue a session, like `pi --session <file>`. */
export async function startPi(options: { extension: ExtensionFactory; mode?: ExtensionMode; dir?: string; resume?: string }) {
	const dir = options.dir ?? mkdtempSync(join(tmpdir(), "pi-bash-jobs-e2e-"));
	const faux = fauxProvider();
	const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: dir,
			settingsManager,
			modelRuntime,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				extensionFactories: [options.extension],
			},
		});
		const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: faux.getModel(), thinkingLevel: "off" });
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: dir,
		agentDir: dir,
		sessionManager: options.resume
			? SessionManager.open(options.resume, join(dir, "sessions"))
			: SessionManager.create(dir, join(dir, "sessions")),
	});
	/** Bind the current session's extensions (emits session_start), as pi's modes do after each replacement. */
	const bind = () => runtime.session.bindExtensions({ mode: options.mode ?? "rpc" });
	await bind();
	return { dir, faux, runtime, bind, get session() { return runtime.session; } };
}

/** Job messages in the current branch of `session`. */
export function jobMessages(entries: readonly SessionEntry[]) {
	return entries.flatMap((e) =>
		e.type === "custom_message" && e.customType === "bash-jobs"
			? [{ content: typeof e.content === "string" ? e.content : "", details: e.details as BashJobMessageDetails }]
			: [],
	);
}

/** Text of the `toolResult` messages of `toolName` in the branch. */
export function toolResults(entries: readonly SessionEntry[], toolName: string) {
	return entries.flatMap((e) =>
		e.type === "message" && e.message.role === "toolResult" && e.message.toolName === toolName
			? [e.message.content.map((c) => (c.type === "text" ? c.text : "")).join("")]
			: [],
	);
}

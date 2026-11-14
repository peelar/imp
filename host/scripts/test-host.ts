// The host the client's Exact tests start (app.json "commands.server"): the real host with a scripted model in place
// of ChatGPT, a sign-in that approves itself a moment after it shows its code, and the local machine adapter, so the
// apps run in real workers, and a GitHub CLI (fake-gh.mjs) whose repositories are folders in the data directory. When
// the user asks to add "todo: <title>", the model runs the todos app's add action, then says "Done."
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { startHost } from "../src/host.ts";
import { localProvider } from "../src/machine-local.ts";
import { CHATGPT } from "../src/signin.ts";

const respond: FauxResponseFactory = (context) => {
	// The last message the model answers: a changed prompt section (a secret added) comes as a system message after it.
	const last = context.messages.filter((m) => m.role !== "system").at(-1) as { role: string; content: unknown } | undefined;
	if (last?.role === "toolResult") {
		// What a command printed, when it printed a secret's stand-in: the test checks the agent saw no more than that.
		const seen = JSON.stringify(last.content).match(/imp-secret-[a-z0-9-]+/);
		return fauxAssistantMessage(seen ? `I see ${seen[0]}.` : "Done.");
	}
	const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
	// Memory's reflection after a run: "I live in <place>" anywhere in the exchange is a fact about the person.
	const first = context.messages[0];
	if (first?.role === "system" && JSON.stringify(first.content).includes("long-term memory of Imp")) {
		const place = text.match(/I live in (\p{L}+)/u)?.[1];
		return fauxAssistantMessage(JSON.stringify({ remember: place ? [{ about: "user", facts: [`Lives in ${place}`] }] : [] }));
	}
	const wanted = text.match(/ask for a key: ([a-z]+)/);
	if (wanted) return fauxAssistantMessage(fauxToolCall("request_secret", { service: wanted[1]!, why: "To read your issues." }), { stopReason: "toolUse" });
	const command = text.match(/run: ([^"\\]+)/);
	if (command) return fauxAssistantMessage(fauxToolCall("bash", { command: command[1]!.trim() }), { stopReason: "toolUse" });
	const todo = text.match(/todo: ([^"\\]+)/);
	if (todo) return fauxAssistantMessage(fauxToolCall("run_app_action", { app: "todos", action: "add", args: { title: todo[1]!.trim() } }), { stopReason: "toolUse" });
	const fact = text.match(/remember: ([^"\\]+)/);
	if (fact) return fauxAssistantMessage(fauxToolCall("remember", { about: "user", facts: [fact[1]!.trim()] }), { stopReason: "toolUse" });
	// "What do you know about me?" answers with what the memory section put in the system prompt, latest version last.
	if (/know about me/.test(text)) {
		const sections = context.messages.flatMap((m) => (m.role === "system" && m.sections?.memory ? [m.sections.memory] : []));
		const known = sections.at(-1)?.match(/about the person:\n([^]*?)(?:\n\n|\n<\/memory>|$)/)?.[1]?.trim();
		return fauxAssistantMessage(known ? `I know: ${known.replace(/^- /gm, "").replace(/\n/g, "; ")}` : "Nothing yet.");
	}
	return fauxAssistantMessage("Hello from the test model.");
};

const faux = fauxProvider({ provider: CHATGPT, models: [{ id: "faux-1" }], tokensPerSecond: 200 });
faux.setResponses(Array.from({ length: 500 }, () => respond));

// A ChatGPT sign-in shaped like the real device code flow: it asks for the method, shows a code, then succeeds.
const claims = { email: "tester@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } };
const access = ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
const credential = () => ({ type: "oauth" as const, access, refresh: "refresh", expires: Date.now() + 3_600_000 });
const auth: Provider["auth"] = {
	oauth: {
		name: "ChatGPT (test)",
		async login(interaction) {
			await interaction.prompt({ type: "select", message: "Method", options: [{ id: "device_code", label: "Device code" }] });
			interaction.notify({ type: "device_code", userCode: "TEST-1234", verificationUri: "https://auth.openai.com/codex/device" });
			await new Promise((resolve, reject) => {
				const timer = setTimeout(resolve, Number(process.env.TEST_SIGNIN_MS ?? 1500));
				interaction.signal.addEventListener("abort", () => (clearTimeout(timer), reject(new Error("Login cancelled"))));
			});
			return credential();
		},
		refresh: async () => credential(),
		toAuth: async (stored) => ({ apiKey: stored.access }),
	},
};
const chatgpt = new Proxy(faux.provider, { get: (target, key) => (key === "auth" ? auth : Reflect.get(target, key)) });

const models = createModels();
models.setProvider(chatgpt);
const dataDir = mkdtempSync(join(tmpdir(), "imp-test-"));
await startHost({
	models,
	model: { provider: CHATGPT, modelId: "faux-1" },
	machines: (secret) => localProvider({ secret, dir: join(dataDir, "machines") }),
	dataDir,
	appsDir: join(import.meta.dirname, "..", "..", "client", "apps"),
	// OpenBao and mitmproxy, downloaded once for every test run.
	toolsDir: join(tmpdir(), "imp-tools"),
	gh: join(import.meta.dirname, "fake-gh.mjs"),
	port: Number(process.env.PORT ?? 8787),
});

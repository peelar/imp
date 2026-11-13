// The host the client's Exact tests start (app.json "commands.server"): the real host with a scripted model in place
// of ChatGPT, a sign-in that approves itself a moment after it shows its code, and the local machine adapter, so the
// apps run in real workers. When the user asks to add "todo: <title>", the model calls todos_add, then says "Done."
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { startHost } from "../src/host.ts";
import { localProvider } from "../src/machine-local.ts";
import { CHATGPT } from "../src/signin.ts";

const respond: FauxResponseFactory = (context) => {
	const last = context.messages.at(-1) as { role: string; content: unknown } | undefined;
	if (last?.role === "toolResult") return fauxAssistantMessage("Done.");
	const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
	const todo = text.match(/todo: ([^"\\]+)/);
	if (todo) return fauxAssistantMessage(fauxToolCall("todos_add", { title: todo[1]!.trim() }), { stopReason: "toolUse" });
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
	port: Number(process.env.PORT ?? 8787),
});

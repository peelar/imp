// The host the client's Exact tests start (app.json "commands.server"): the real host with a scripted model in place
// of ChatGPT, a sign-in that approves itself a moment after it shows its code, and the local machine adapter, so the
// apps run in real workers. When the user asks to add "todo: <title>", the model runs the todos app's add action, then
// says "Done."; "remember: <fact>", "app code: <id>" and "preview app: <id>" make it call the memory's and the studio's
// tools the same way. TEST_DATA_DIR names the host's data directory, for a test that starts the host again on it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { startHost } from "../src/host.ts";
import { localProvider } from "../src/machine-local.ts";
import { CHATGPT } from "../src/signin.ts";

type Content =
  Parameters<FauxResponseFactory>[0]["messages"][number]["content"];

const isText = (content: Content | undefined): content is string =>
  typeof content === "string";

/** The tool calls a message can ask for; the first pattern it matches wins, called with what the pattern captured. */
const TOOL_CALLS = [
  {
    pattern: /todo: ([^"\\]+)/,
    call: (title: string) =>
      fauxToolCall("run_app_action", {
        app: "todos",
        action: "add",
        args: { title },
      }),
  },
  {
    pattern: /remember: ([^"\\]+)/,
    call: (fact: string) =>
      fauxToolCall("remember", { about: "user", facts: [fact] }),
  },
  {
    pattern: /app code: ([a-z0-9]+)/,
    call: (app: string) => fauxToolCall("app_code", { app }),
  },
  {
    pattern: /preview app: ([a-z0-9]+)/,
    call: (app: string) => fauxToolCall("preview_app", { app }),
  },
];

const toolCall = (text: string) =>
  TOOL_CALLS.flatMap(({ pattern, call }) => {
    const [, asked] = pattern.exec(text) ?? [];

    return asked === undefined ? [] : [call(asked.trim())];
  }).at(0);

const respond: FauxResponseFactory = (context) => {
  // A prompt section that changed since the last turn (the memory's, say) arrives as a system message after the
  // message it answers to, so the turn's last word is the last message that is not one.
  const last = context.messages.findLast(({ role }) => role !== "system");

  if (last?.role === "toolResult") {
    return fauxAssistantMessage("Done.");
  }

  const text = isText(last?.content)
    ? last.content
    : JSON.stringify(last?.content ?? "");

  // Memory's reflection after a run: "I live in <place>" anywhere in the exchange is a fact about the person.
  const [first] = context.messages;

  if (
    first?.role === "system" &&
    JSON.stringify(first.content).includes("long-term memory of Imp")
  ) {
    const [, place] = /I live in (\p{L}+)/u.exec(text) ?? [];

    return fauxAssistantMessage(
      JSON.stringify({
        remember: place
          ? [{ about: "user", facts: [`Lives in ${place}`] }]
          : [],
      })
    );
  }

  const call = toolCall(text);

  if (call) {
    return fauxAssistantMessage(call, { stopReason: "toolUse" });
  }

  // "What do you know about me?" answers with what the memory section put in the system prompt, latest version last.
  if (text.includes("know about me")) {
    const sections = context.messages.flatMap((m) =>
      m.role === "system" && m.sections?.memory ? [m.sections.memory] : []
    );

    const known = sections
      .at(-1)
      ?.match(/about the person:\n([^]*?)(?:\n\n|\n<\/memory>|$)/)?.[1]
      ?.trim();

    return fauxAssistantMessage(
      known
        ? `I know: ${known.replaceAll(/^- /gm, "").replaceAll("\n", "; ")}`
        : "Nothing yet."
    );
  }

  return fauxAssistantMessage("Hello from the test model.");
};

const faux = fauxProvider({
  provider: CHATGPT,
  models: [{ id: "faux-1" }],
  tokensPerSecond: 200,
});

faux.setResponses(Array.from({ length: 500 }, () => respond));

// A ChatGPT sign-in shaped like the real device code flow: it asks for the method, shows a code, then succeeds.
const claims = {
  email: "tester@example.com",
  "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
};

const access = [
  "e30",
  Buffer.from(JSON.stringify(claims)).toString("base64url"),
  "sig",
].join(".");

const credential = () => ({
  type: "oauth" as const,
  access,
  refresh: "refresh",
  expires: Date.now() + 3_600_000,
});

const auth: Provider["auth"] = {
  oauth: {
    name: "ChatGPT (test)",
    async login(interaction) {
      await interaction.prompt({
        type: "select",
        message: "Method",
        options: [{ id: "device_code", label: "Device code" }],
      });
      interaction.notify({
        type: "device_code",
        userCode: "TEST-1234",
        verificationUri: "https://auth.openai.com/codex/device",
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          resolve,
          Number(process.env.TEST_SIGNIN_MS ?? 1500)
        );

        interaction.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("Login cancelled"));
        });
      });

      return credential();
    },
    refresh: async () => credential(),
    toAuth: async (stored) => ({ apiKey: stored.access }),
  },
};

const chatgpt: Provider = { ...faux.provider, auth };

const models = createModels();

models.setProvider(chatgpt);

const dataDir =
  process.env.TEST_DATA_DIR ?? mkdtempSync(path.join(tmpdir(), "imp-test-"));

await startHost({
  models,
  model: { provider: CHATGPT, modelId: "faux-1" },
  machines: (secret) =>
    localProvider({ secret, dir: path.join(dataDir, "machines") }),
  dataDir,
  appsDir: path.join(import.meta.dirname, "..", "..", "client", "apps"),
  port: Number(process.env.PORT ?? 8787),
});

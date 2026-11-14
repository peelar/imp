// The host the client's Exact tests start (app.json "commands.server"): the real host with a scripted model in place
// of ChatGPT, a sign-in that approves itself a moment after it shows its code, the local machine adapter, so the apps
// run in real workers, and a GitHub CLI (fake-gh.ts) whose repositories are folders in the data directory. When the
// user asks to add "todo: <title>", the model runs the todos app's add action, then says "Done."; "remember: <fact>",
// "app code: <id>", "preview app: <id>", "ask for a key: <service>" and "run: <command>" make it call the memory's,
// the studio's, the secrets' and the shell tools the same way. Its agent-browser knows two tricks. TEST_DATA_DIR names the host's data directory, for a
// test that starts the host again on it.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
    pattern: /ask for a key: ([a-z]+)/,
    call: (service: string) =>
      fauxToolCall("request_secret", { service, why: "To read your issues." }),
  },
  {
    pattern: /run: ([^"\\]+)/,
    call: (command: string) => fauxToolCall("bash", { command }),
  },
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
    // What a command printed, when it printed a secret's stand-in: the test checks the agent saw no more than that.
    const [seen] =
      /imp-secret-[a-z0-9-]+/.exec(JSON.stringify(last.content)) ?? [];

    return fauxAssistantMessage(seen ? `I see ${seen}.` : "Done.");
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

// The machine's agent-browser, which the host asks for the imp's tricks (tricks.ts): a stand-in that knows two.
const flows = [
  {
    name: "hn-search",
    description: "Search Hacker News",
    origin: "hn.algolia.com",
    params: ["query"],
  },
  {
    name: "parcel",
    description: "Track a parcel",
    origin: "inpost.pl",
    params: ["number"],
  },
];

const bin = path.join(dataDir, "bin");

mkdirSync(bin, { recursive: true });

writeFileSync(
  path.join(bin, "agent-browser"),
  `#!/bin/sh\n[ "$1 $2" = "flow list" ] || { echo "agent-browser (test): only flow list" >&2; exit 1; }\necho '${JSON.stringify({ success: true, data: { flows } })}'\n`,
  { mode: 0o755 }
);

process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;

await startHost({
  models,
  model: { provider: CHATGPT, modelId: "faux-1" },
  machines: (secret) =>
    localProvider({ secret, dir: path.join(dataDir, "machines") }),
  dataDir,
  appsDir: path.join(import.meta.dirname, "..", "..", "client", "apps"),
  // OpenBao and mitmproxy, downloaded once for every test run.
  toolsDir: path.join(tmpdir(), "imp-tools"),
  gh: path.join(import.meta.dirname, "fake-gh.ts"),
  port: Number(process.env.PORT ?? 8787),
});

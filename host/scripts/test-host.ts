// The host the client's Exact tests start (app.json "commands.server"): the real host with a scripted model in place
// of ChatGPT, a sign-in that approves itself a moment after it shows its code, the local machine adapter, so the apps
// run in real workers, and a GitHub CLI (fake-gh.ts) whose repositories are folders in the data directory. When the
// user asks to add "todo: <title>", the model runs the todos app's add action, then says "Done."; "remember: <fact>",
// "app code: <id>", "preview app: <id>", "ask for a key: <service>", "ask for a login: <site>", "sign in: <login>",
// "run: <command>" and "save routine: <name> | <cron> | <instruction>" make it call the memory's, the studio's, the
// secrets', the shell's and the routines' tools the same way, and "reply: <words>" makes it answer those words. Its
// The model is "faux-1", with "faux-2" to fall back on: "refuse: <model>" (or "all") makes that model refuse as
// ChatGPT refuses one the account's plan does not cover, and "which model?" answers the one that took it. Its
// agent-browser knows two tricks. TEST_DATA_DIR names
// the host's data directory, for a test that starts the host again on it.
//
// Beside it, on TEST_API_PORT (default 8799), a server that speaks OpenAI's Chat Completions API, for the API key
// sign-in: it takes the key "test-key" and the model "fake-model", and answers every message "Hello from the API."
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
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
import { localProvider } from "../src/computer/local.ts";
import { CHATGPT, openCredentialStore } from "../src/account/account.ts";

type Content =
  Parameters<FauxResponseFactory>[0]["messages"][number]["content"];

const isText = (content: Content | undefined): content is string =>
  typeof content === "string";

/** The tool calls a message can ask for; the first pattern it matches wins, called with what the pattern captured. */
const TOOL_CALLS = [
  {
    // "save routine: <name> | <cron> | <instruction>"
    pattern: /save routine: ([^"\\]+)/,
    call: (asked: string) => {
      const [name = "", schedule = "", instruction = ""] = asked.split(" | ");

      return fauxToolCall("save_routine", {
        name,
        when: schedule,
        schedule,
        timezone: "Europe/Warsaw",
        instruction,
      });
    },
  },
  {
    pattern: /ask for a key: ([a-z]+)/,
    call: (service: string) =>
      fauxToolCall("request_secret", { service, why: "To read your issues." }),
  },
  {
    pattern: /ask for a login: ([a-z.]+)/,
    call: (host: string) =>
      fauxToolCall("request_secret", {
        service: "login",
        host,
        why: "To check your notifications.",
      }),
  },
  {
    pattern: /sign in: ([a-z0-9-]+)/,
    call: (secret: string) => fauxToolCall("sign_in", { secret }),
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

/** What the memory section put in the system prompt about the person, latest version last, as the model says it. */
function recalled(context: Parameters<FauxResponseFactory>[0]) {
  const sections = context.messages.flatMap((m) =>
    m.role === "system" && m.sections?.memory ? [m.sections.memory] : []
  );

  const known = sections
    .at(-1)
    ?.match(/about the person:\n([^]*?)(?:\n\n|\n<\/memory>|$)/)?.[1]
    ?.trim();

  return known
    ? `I know: ${known.replaceAll(/^- /gm, "").replaceAll("\n", "; ")}`
    : "Nothing yet.";
}

/**
 * "refuse: <model>" (or "all") is refused as ChatGPT refuses a model the account's plan does not cover; "which model?"
 * answers the model that took it.
 */
function modelChoice(text: string, model: string) {
  const [, refused] = /refuse: ([a-z0-9-]+)/.exec(text) ?? [];

  if (refused === model || refused === "all") {
    return fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: `Codex error: The '${model}' model is not supported when using Codex with a ChatGPT account.`,
    });
  }

  return refused || text.includes("which model")
    ? fauxAssistantMessage(`Answered on ${model}.`)
    : undefined;
}

// The model that is asked comes last, after the request's options and the provider's state.
const respond: FauxResponseFactory = (context, ...rest) => {
  const { 2: model } = rest;
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

  const choice = modelChoice(text, model.id);

  if (choice) {
    return choice;
  }

  const call = toolCall(text);

  if (call) {
    return fauxAssistantMessage(call, { stopReason: "toolUse" });
  }

  // "reply: <words>" answers those words, as a routine's run that found something, or nothing new, does.
  const [, words] = /\breply: ([^]+)$/.exec(text) ?? [];

  if (words !== undefined) {
    return fauxAssistantMessage(words);
  }

  // "What do you know about me?" answers with what the memory section put in the system prompt.
  if (text.includes("know about me")) {
    return fauxAssistantMessage(recalled(context));
  }

  return fauxAssistantMessage("Hello from the test model.");
};

const faux = fauxProvider({
  provider: CHATGPT,
  models: [{ id: "faux-1" }, { id: "faux-2" }],
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

// With TEST_SIGNIN_UNREACHABLE, the first sign-in fails as the real one does when the host cannot reach ChatGPT.
let unreachable = Boolean(process.env.TEST_SIGNIN_UNREACHABLE);

const auth: Provider["auth"] = {
  oauth: {
    name: "ChatGPT (test)",
    async login(interaction) {
      if (unreachable) {
        unreachable = false;
        // .invalid names never resolve (RFC 6761).
        await fetch("https://auth.invalid/oauth/device");
      }

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

/** What the API answers besides a chat: its model list, or why it refused. */
type ApiAnswer =
  | { readonly error: { readonly message: string } }
  | { readonly object: "list"; readonly data: readonly { id: string }[] };

/** One streamed choice of a Chat Completions answer, and the usage the last one carries. */
type Chunk = {
  readonly delta: { readonly role?: string; readonly content?: string };
  readonly finish_reason?: string;
  readonly usage?: { prompt_tokens: number; completion_tokens: number };
};

const json = (res: ServerResponse, status: number, value: ApiAnswer) =>
  res
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(value));

const chunk = ({ usage, ...choice }: Chunk) =>
  `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, ...choice }], usage })}\n\n`;

const api = createServer((req, res) => {
  req.resume();

  if (req.headers.authorization !== "Bearer test-key") {
    json(res, 401, { error: { message: "Incorrect API key provided." } });
  } else if (req.method === "GET" && req.url === "/v1/models") {
    json(res, 200, { object: "list", data: [{ id: "fake-model" }] });
  } else if (req.method === "POST" && req.url === "/v1/chat/completions") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      [
        chunk({ delta: { role: "assistant", content: "Hello from " } }),
        chunk({ delta: { content: "the API." } }),
        chunk({
          delta: {},
          finish_reason: "stop",
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        "data: [DONE]\n\n",
      ].join("")
    );
  } else {
    json(res, 404, { error: { message: "Not found." } });
  }
});

api.listen(Number(process.env.TEST_API_PORT ?? 8799), "127.0.0.1");

const dataDir =
  process.env.TEST_DATA_DIR ?? mkdtempSync(path.join(tmpdir(), "imp-test-"));

// Kept in the data directory, as the real host keeps them: a host started again on it is still signed in.
const models = createModels({
  credentials: openCredentialStore(path.join(dataDir, "credentials.sqlite")),
});

models.setProvider(chatgpt);

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

// The tests reach every feature, so the test host turns the GitHub app's flag on, unless a test chose for itself.
const flags = path.join(dataDir, "flags.json");

if (!existsSync(flags)) {
  writeFileSync(
    flags,
    JSON.stringify({ "github-app": true, "app-directory": true })
  );
}

await startHost({
  models,
  model: { provider: CHATGPT, modelId: "faux-1" },
  fallbacks: ["faux-2"],
  machines: (secret) =>
    localProvider({ secret, dir: path.join(dataDir, "machines") }),
  dataDir,
  appsDir: path.join(import.meta.dirname, "..", "..", "client", "apps"),
  // OpenBao and mitmproxy, downloaded once for every test run.
  toolsDir: path.join(tmpdir(), "imp-tools"),
  gh: path.join(import.meta.dirname, "fake-gh.ts"),
  exact: process.env.EXACT,
  port: Number(process.env.PORT ?? 8787),
});

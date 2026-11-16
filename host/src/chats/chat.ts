// A conversation as the shell shows it: what the person said, what the assistant answered, and what it did along the
// way (one activity row per tool call, in words, not JSON), plus the reply being written. chats.ts keeps the list of
// conversations and which one is open.
import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type Conversation,
  type EntryRecord,
  type Harness,
  LiveDoc,
} from "@earendil-works/pi-durable";
import { personText } from "./origin.ts";
import { messageText } from "./message-text.ts";

export const TOPIC = "chat";
const SHOWN = 80;

/**
 * One row of the transcript. `role` is "user", "assistant" (Markdown in `text`), "activity" (a tool call: `title`,
 * `detail`, `icon`, and `failed` when it errored, with a title that says so and `text` the error), "error" (the model
 * failed: `text` says why), or "thinking" (the
 * last row while the assistant works with no words on the way).
 */
export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "activity" | "error" | "thinking";
  text: string;
  title: string;
  detail: string;
  icon: string;
  failed: boolean;
};

export type AppLabel = {
  readonly id: string;
  readonly name: string;
  readonly symbol: string;
};

/** A value the model sent or a tool answered. */
type Value = null | boolean | number | string | readonly Value[] | ToolArgs;

/** A tool call's arguments by name, as the model sent them. */
type ToolArgs = { readonly [name: string]: Value };

const isText = (value: Value | undefined): value is string =>
  typeof value === "string";

const isNamed = (value: Value | undefined): value is ToolArgs =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A value on one line of at most `max` characters; a value that is not text is written as JSON. */
const oneLine = (value: Value | undefined, max = 90) => {
  const written = isText(value) ? value : JSON.stringify(value ?? "");
  const text = written.replaceAll(/\s+/g, " ").trim();

  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** "find_app_actions" or "setDone" as "Find app actions" or "Set done". */
const humanize = (name: string) => {
  const words = name
    .replaceAll("_", " ")
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();

  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** An app's action: "Todos · Add" and its first text argument, such as the todo's title. */
function describeAction(args: ToolArgs, apps: readonly AppLabel[]) {
  const app = apps.find((a) => a.id === args.app);
  const values = isNamed(args.args) ? Object.values(args.args) : [];

  const subject = values.find((value) => isText(value) && !/^\d+$/.test(value));

  const title = `${app?.name ?? oneLine(args.app)} · ${humanize(oneLine(args.action))}`;

  return {
    title,
    failedTitle: `${title} failed`,
    detail: subject === undefined ? "" : oneLine(subject),
    icon: app?.symbol ?? "symbol:icon.layers",
  };
}

/**
 * The tools the person reads about in their own words: the title, the title when the tool failed, the icon, and the
 * argument that says which.
 */
const KNOWN = new Map<string, readonly [string, string, string, string]>([
  [
    "bash",
    ["Ran a command", "A command failed", "symbol:icon.terminal", "command"],
  ],
  [
    "powershell",
    ["Ran a command", "A command failed", "symbol:icon.terminal", "command"],
  ],
  [
    "read",
    ["Read a file", "Couldn't read a file", "symbol:icon.document", "path"],
  ],
  [
    "write",
    ["Wrote a file", "Couldn't write a file", "symbol:icon.compose", "path"],
  ],
  [
    "edit",
    ["Edited a file", "Couldn't edit a file", "symbol:icon.pencil", "path"],
  ],
  [
    "app_code",
    [
      "Opened an app's code",
      "Couldn't open an app's code",
      "symbol:icon.document",
      "app",
    ],
  ],
  [
    "preview_app",
    [
      "Built a preview",
      "Couldn't build a preview",
      "symbol:icon.sparkles",
      "app",
    ],
  ],
  [
    "find_app_actions",
    [
      "Looked up app actions",
      "Couldn't look up app actions",
      "symbol:icon.search",
      "query",
    ],
  ],
  [
    "request_secret",
    [
      "Asked for a secret",
      "Couldn't ask for a secret",
      "symbol:icon.lock",
      "service",
    ],
  ],
  ["sign_in", ["Signed in", "Couldn't sign in", "symbol:icon.lock", "secret"]],
  [
    "save_routine",
    [
      "Saved a routine",
      "Couldn't save a routine",
      "symbol:icon.repeat",
      "name",
    ],
  ],
  [
    "delete_routine",
    [
      "Deleted a routine",
      "Couldn't delete a routine",
      "symbol:icon.repeat",
      "name",
    ],
  ],
]);

type ToolUse = {
  readonly name: string;
  readonly args: ToolArgs;
  readonly apps: readonly AppLabel[];
};

/** The first of a command's values for `--description`, quoted or not. */
const described = (command: string) => {
  const [, ...values] =
    /--description[ =](?:"([^"]*)"|'([^']*)'|(\S+))/.exec(command) ?? [];

  return values.find(Boolean);
};

/** A command that drives agent-browser, in words: the tricks the imp learns and runs, and the pages it uses. */
function browserStep(command: string) {
  const icon = "symbol:icon.sparkles";
  const [, saved] = /\bflow\s+save\s+(\S+)/.exec(command) ?? [];

  if (saved !== undefined) {
    return {
      title: "Learned a trick",
      failedTitle: "Couldn't learn a trick",
      detail: oneLine(described(command) ?? saved),
      icon,
    };
  }

  const [, ran] = /\bflow\s+run\s+([^\n;&|]+)/.exec(command) ?? [];

  if (ran !== undefined) {
    return {
      title: "Ran a trick",
      failedTitle: "A trick failed",
      detail: oneLine(ran),
      icon,
    };
  }

  const [, opened] =
    /\bagent-browser\b[^\n;&|]*?\sopen\s+(\S+)/.exec(command) ?? [];

  return opened === undefined
    ? {
        title: "Used the browser",
        failedTitle: "The browser failed",
        detail: oneLine(command.replace(/^[^]*?\bagent-browser\s+/, "")),
        icon: "symbol:icon.link",
      }
    : {
        title: "Opened a page",
        failedTitle: "Couldn't open a page",
        detail: oneLine(opened.replaceAll(/^["']|["']$/g, "")),
        icon: "symbol:icon.link",
      };
}

/** What a tool call did, in words the person reads at a glance. */
function describeTool({ name, args, apps }: ToolUse) {
  if (name === "run_app_action") {
    return describeAction(args, apps);
  }

  const { command } = args;

  if (name === "bash" && isText(command) && /\bagent-browser\b/.test(command)) {
    return browserStep(command);
  }

  const known = KNOWN.get(name);

  if (!known) {
    const title = humanize(name);

    return {
      title,
      failedTitle: `${title} failed`,
      detail: "",
      icon: "symbol:icon.sparkles",
    };
  }

  const [title, failedTitle, icon, subject] = known;

  return { title, failedTitle, detail: oneLine(args[subject]), icon };
}

/**
 * A tool's error as the person reads it: what the tool said, such as a command's output, without the harness's notes
 * after it ("[error] Command exited with code 1"); the notes alone, unwrapped, when the tool said nothing.
 */
const whyFailed = (text: string) => {
  const said = text.replaceAll(/<harness>[^]*?<\/harness>/g, "").trim();

  return said === ""
    ? text.replaceAll(/<\/?harness>|\[(?:error|warning|info)\]\s*/g, "").trim()
    : said;
};

const row = (
  id: string,
  role: ChatMessage["role"],
  fields: Partial<ChatMessage>
): ChatMessage => ({
  id,
  role,
  text: "",
  title: "",
  detail: "",
  icon: "",
  failed: false,
  ...fields,
});

type Calls = Map<string, { name: string; args: ToolArgs }>;

/** The rows of what the assistant said, remembering its tool calls for their results. */
function assistantRows(id: string, message: AssistantMessage, calls: Calls) {
  for (const part of message.content) {
    if (part.type === "toolCall" && part.id) {
      calls.set(part.id, { name: part.name, args: part.arguments });
    }
  }

  const text = messageText(message.content);

  return [
    ...(text ? [row(id, "assistant", { text })] : []),
    ...(message.errorMessage
      ? [row(`${id}-error`, "error", { text: message.errorMessage })]
      : []),
  ];
}

/** The transcript's rows for the conversation's entries, oldest first. */
function transcript(
  entries: readonly EntryRecord[],
  apps: readonly AppLabel[]
) {
  // A tool result names its call; the call, in the assistant message before it, holds the arguments.
  const calls: Calls = new Map();

  return entries.flatMap((entry): ChatMessage[] => {
    const [message] = entry.model ?? [];
    const id = String(entry.id);

    if (entry.kind === "pi.user" && message?.role === "user") {
      const text = personText(messageText(message.content));

      return [row(id, "user", { text })];
    }

    if (entry.kind === "pi.assistant" && message?.role === "assistant") {
      return assistantRows(id, message, calls);
    }

    if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
      const call = calls.get(message.toolCallId);

      const { title, failedTitle, detail, icon } = describeTool({
        name: message.toolName || (call?.name ?? "tool"),
        args: call?.args ?? {},
        apps,
      });

      // A failed step says so in its title, and its text is why.
      return [
        row(id, "activity", {
          title: message.isError ? failedTitle : title,
          detail,
          icon,
          failed: message.isError,
          text: oneLine(
            message.isError
              ? whyFailed(messageText(message.content))
              : messageText(message.content),
            300
          ),
        }),
      ];
    }

    return [];
  });
}

export type ConversationOptions = {
  readonly harness: Harness;
  readonly conversation: Conversation;
  /** The apps whose actions the transcript names. */
  readonly apps: readonly AppLabel[];
  readonly context: Context;
};

/** What the agent is doing in a conversation now: whether it works, and the words of the reply on the way. */
export async function liveState(
  harness: Harness,
  id: Conversation["id"],
  context: Context
) {
  const doc = await harness.snapshot(LiveDoc, id, context);

  return {
    busy: doc?.run !== undefined,
    streaming: messageText(doc?.generation?.message?.content),
  };
}

/** The conversation's transcript, with the reply on the way, and whether the agent works in it. */
export async function conversationState(options: ConversationOptions) {
  const { harness, conversation, apps, context } = options;

  const page = await conversation.entries(
    { order: "descending" },
    SHOWN,
    undefined,
    context
  );

  const messages = transcript(page.items.toReversed(), apps);

  const { busy, streaming } = await liveState(
    harness,
    conversation.id,
    context
  );

  if (busy && streaming) {
    messages.push(row("live", "assistant", { text: streaming }));
  }
  // Busy with no words on the way (before the first, or while a tool runs): the shell draws a thinking row.
  else if (busy) {
    messages.push(row("thinking", "thinking", {}));
  }

  return { messages, busy };
}

/** What the person's first message in a conversation says, on one line, to name it in the sidebar. */
export async function firstWords(conversation: Conversation, context: Context) {
  const page = await conversation.entries(
    { order: "ascending" },
    20,
    undefined,
    context
  );

  const first = page.items.find((entry) => entry.kind === "pi.user");
  const [message] = first?.model ?? [];

  return message?.role === "user"
    ? titleOf(personText(messageText(message.content)))
    : "";
}

/** Whether a conversation's last run ended with the model failing. */
export async function lastFailed(conversation: Conversation, context: Context) {
  const page = await conversation.entries(
    { order: "descending" },
    1,
    undefined,
    context
  );

  const [message] = page.items[0]?.model ?? [];

  return message?.role === "assistant" && Boolean(message.errorMessage);
}

/** What the assistant last said in a conversation, and why the model failed if it did ("" when it did not). */
export async function lastReply(conversation: Conversation, context: Context) {
  const page = await conversation.entries(
    { order: "descending" },
    20,
    undefined,
    context
  );

  for (const entry of page.items) {
    const [message] = entry.model ?? [];

    if (entry.kind === "pi.assistant" && message?.role === "assistant") {
      const text = messageText(message.content);
      const error = message.errorMessage ?? "";

      if (text || error) {
        return { text, error };
      }
    }
  }

  return { text: "", error: "" };
}

/** A conversation's name in the sidebar: its first message, on one line. */
export const titleOf = (text: string) => oneLine(text, 60);

// The home conversation as the shell shows it: what the person said, what the assistant answered, and what it did
// along the way (one activity row per tool call, in words, not JSON), plus the reply being written.
import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type Conversation,
  type EntryRecord,
  type Harness,
  LiveDoc,
} from "@earendil-works/pi-durable";
import type { Topics } from "./live.ts";
import { messageText } from "./message-text.ts";

export const TOPIC = "chat";
const SHOWN = 80;

/**
 * One row of the transcript. `role` is "user", "assistant" (Markdown in `text`), "activity" (a tool call: `title`,
 * `detail`, `icon`, and `failed` when it errored), "error" (the model failed: `text` says why), or "thinking" (the
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

// A message sent from the chat beside an app starts with a line naming that app, so the agent knows what "this" is.
// The transcript drops the line again: the person never wrote it.
const CONTEXT = /^\[Sent from the chat beside the [^\]\n]+ app\.\]\n\n/;

/** The message the agent receives when the person writes beside an open app. */
export const withAppContext = (text: string, app: AppLabel | undefined) =>
  app ? `[Sent from the chat beside the ${app.name} app.]\n\n${text}` : text;

/** An app's action: "Todos · Add" and its first text argument, such as the todo's title. */
function describeAction(args: ToolArgs, apps: readonly AppLabel[]) {
  const app = apps.find((a) => a.id === args.app);
  const values = isNamed(args.args) ? Object.values(args.args) : [];

  const subject = values.find((value) => isText(value) && !/^\d+$/.test(value));

  return {
    title: `${app?.name ?? oneLine(args.app)} · ${humanize(oneLine(args.action))}`,
    detail: subject === undefined ? "" : oneLine(subject),
    icon: app?.symbol ?? "symbol:layers",
  };
}

/** The tools the person reads about in their own words: the title, the icon, and the argument that says which. */
const KNOWN = new Map<string, readonly [string, string, string]>([
  ["bash", ["Ran a command", "symbol:icon.terminal", "command"]],
  ["powershell", ["Ran a command", "symbol:icon.terminal", "command"]],
  ["read", ["Read a file", "symbol:document", "path"]],
  ["write", ["Wrote a file", "symbol:compose", "path"]],
  ["edit", ["Edited a file", "symbol:pencil", "path"]],
  ["app_code", ["Opened an app's code", "symbol:document", "app"]],
  ["preview_app", ["Built a preview", "symbol:sparkles", "app"]],
  ["find_app_actions", ["Looked up app actions", "symbol:search", "query"]],
]);

export type ToolUse = {
  readonly name: string;
  readonly args: ToolArgs;
  readonly apps: readonly AppLabel[];
};

/** What a tool call did, in words the person reads at a glance. */
export function describeTool({ name, args, apps }: ToolUse) {
  if (name === "run_app_action") {
    return describeAction(args, apps);
  }

  const known = KNOWN.get(name);

  if (!known) {
    return { title: humanize(name), detail: "", icon: "symbol:sparkles" };
  }

  const [title, icon, subject] = known;

  return { title, detail: oneLine(args[subject]), icon };
}

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
      const text = messageText(message.content).replace(CONTEXT, "");

      return [row(id, "user", { text })];
    }

    if (entry.kind === "pi.assistant" && message?.role === "assistant") {
      return assistantRows(id, message, calls);
    }

    if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
      const call = calls.get(message.toolCallId);

      const described = describeTool({
        name: message.toolName || (call?.name ?? "tool"),
        args: call?.args ?? {},
        apps,
      });

      return [
        row(id, "activity", {
          ...described,
          failed: message.isError,
          text: oneLine(messageText(message.content), 300),
        }),
      ];
    }

    return [];
  });
}

export type HomeChatOptions = {
  readonly harness: Harness;
  readonly home: Conversation;
  readonly topics: Topics;
  /** The apps whose actions the transcript names. */
  readonly apps: () => readonly AppLabel[];
  readonly context: Context;
};

export async function homeChat(options: HomeChatOptions) {
  const { harness, home, topics, apps, context } = options;

  /** What the agent is doing now: whether it works, and the words of the reply on the way. */
  async function live() {
    const doc = await harness.snapshot(LiveDoc, home.id, context);

    return {
      busy: doc?.run !== undefined,
      streaming: messageText(doc?.generation?.message?.content),
    };
  }

  async function state() {
    const page = await home.entries(
      { order: "descending" },
      SHOWN,
      undefined,
      context
    );

    const messages = transcript(page.items.toReversed(), apps());
    const { busy, streaming } = await live();

    if (busy && streaming) {
      messages.push(row("live", "assistant", { text: streaming }));
    }
    // Busy with no words on the way (before the first, or while a tool runs): the shell draws a thinking row.
    else if (busy) {
      messages.push(row("thinking", "thinking", {}));
    }

    return { messages, busy };
  }

  // Every commit to the conversation, including each streamed piece of a reply, refreshes the open chat views.
  const watch = await home.watch(context);

  watch.start(async () => {
    topics.changed(TOPIC);
  });

  return {
    state,
    /** Whether the agent is in a turn. */
    busy: async () => (await live()).busy,
    async close() {
      await watch.stop();
    },
  };
}

export type HomeChat = Awaited<ReturnType<typeof homeChat>>;

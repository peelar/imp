// The home conversation as the shell shows it: what the person said, what the assistant answered, and what it did
// along the way (one activity row per tool call, in words, not JSON), plus the reply being written.
import type { Context } from "@earendil-works/chord/context";
import { type Conversation, type Harness, LiveDoc } from "@earendil-works/pi-durable";
import type { Topics } from "./live.ts";

export const TOPIC = "chat";
const SHOWN = 80;

/**
 * One row of the transcript. `role` is "user", "assistant" (Markdown in `text`), "activity" (a tool call: `title`,
 * `detail`, `icon`, and `failed` when it errored), "error" (the model failed: `text` says why), or "thinking" (the
 * last row while the assistant works with no words on the way).
 */
export interface ChatMessage {
	id: string;
	role: string;
	text: string;
	title: string;
	detail: string;
	icon: string;
	failed: boolean;
}

export interface AppLabel {
	readonly id: string;
	readonly name: string;
	readonly symbol: string;
}

type Part = { type: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> };

const textOf = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? (content as Part[])
					.filter((part) => part.type === "text")
					.map((part) => part.text ?? "")
					.join("")
					.trim()
			: "";

const oneLine = (value: unknown, max = 90) => {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const humanize = (name: string) => {
	const words = name.replace(/_/g, " ").trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
};

// A message sent from the chat beside an app starts with a line naming that app, so the agent knows what "this" is.
// The transcript drops the line again: the person never wrote it.
const CONTEXT = /^\[Sent from the chat beside the [^\]\n]+ app\.\]\n\n/;

/** The message the agent receives when the person writes beside an open app. */
export const withAppContext = (text: string, app: AppLabel | undefined) =>
	app ? `[Sent from the chat beside the ${app.name} app.]\n\n${text}` : text;

/** What a tool call did, in words the person reads at a glance. */
export function describeTool(name: string, args: Record<string, unknown>, apps: readonly AppLabel[]) {
	switch (name) {
		case "bash":
		case "powershell":
			return { title: "Ran a command", detail: oneLine(args.command), icon: "symbol:icon.terminal" };
		case "read":
			return { title: "Read a file", detail: oneLine(args.path), icon: "symbol:document" };
		case "write":
			return { title: "Wrote a file", detail: oneLine(args.path), icon: "symbol:compose" };
		case "edit":
			return { title: "Edited a file", detail: oneLine(args.path), icon: "symbol:pencil" };
	}
	const app = apps.find((a) => name.startsWith(`${a.id}_`));
	if (app) {
		// An app's tool: "Todos · Add" and its first text argument, such as the todo's title.
		const action = humanize(name.slice(app.id.length + 1));
		const subject = Object.values(args).find((value) => typeof value === "string" && !/^\d+$/.test(value));
		return { title: `${app.name} · ${action}`, detail: subject === undefined ? "" : oneLine(subject), icon: app.symbol };
	}
	return { title: humanize(name), detail: "", icon: "symbol:sparkles" };
}

export async function homeChat(harness: Harness, home: Conversation, topics: Topics, apps: () => readonly AppLabel[], context: Context) {
	async function state() {
		const page = await home.entries({ order: "descending" }, SHOWN, undefined, context);
		const messages: ChatMessage[] = [];
		const row = (id: string, role: string, fields: Partial<ChatMessage>): ChatMessage => ({
			id,
			role,
			text: "",
			title: "",
			detail: "",
			icon: "",
			failed: false,
			...fields,
		});
		// A tool result names its call; the call, in the assistant message before it, holds the arguments.
		const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
		for (const entry of [...page.items].reverse()) {
			const message = entry.model?.[0] as
				| { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean; errorMessage?: string }
				| undefined;
			if (!message) continue;
			const id = String(entry.id);
			if (entry.kind === "pi.user") {
				messages.push(row(id, "user", { text: textOf(message.content).replace(CONTEXT, "") }));
			} else if (entry.kind === "pi.assistant") {
				for (const part of Array.isArray(message.content) ? (message.content as Part[]) : []) {
					if (part.type === "toolCall" && part.id) calls.set(part.id, { name: part.name ?? "", args: part.arguments ?? {} });
				}
				const text = textOf(message.content);
				if (text) messages.push(row(id, "assistant", { text }));
				if (message.errorMessage) messages.push(row(`${id}-error`, "error", { text: message.errorMessage }));
			} else if (entry.kind === "pi.tool-result") {
				const call = calls.get(message.toolCallId ?? "");
				const described = describeTool(message.toolName ?? call?.name ?? "tool", call?.args ?? {}, apps());
				messages.push(row(id, "activity", { ...described, failed: message.isError === true, text: oneLine(textOf(message.content), 300) }));
			}
		}
		const live = await harness.snapshot(LiveDoc, home.id, context);
		const busy = live?.run !== undefined && live?.run !== null;
		const streaming = textOf(live?.generation?.message?.content);
		if (busy && streaming) messages.push(row("live", "assistant", { text: streaming }));
		// Busy with no words on the way (before the first, or while a tool runs): the shell draws a thinking row.
		else if (busy) messages.push(row("thinking", "thinking", {}));
		return { messages, busy };
	}

	// Every commit to the conversation, including each streamed piece of a reply, refreshes the open chat views.
	const watch = await home.watch(context);
	watch.start(async () => topics.changed(TOPIC));

	return {
		state,
		async busy() {
			return (await state()).busy;
		},
		async close() {
			await watch.stop();
		},
	};
}

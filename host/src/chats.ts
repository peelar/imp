// The person's conversations with the imp. The host keeps their list, the one open in the shell, and each one's title
// (its first message) in `conversations.json` in its data directory; a host from before there were several adopts its
// one conversation, the harness's root. A new chat stays out of the sidebar until something is said in it. Each
// routine's conversation is kept here too, named by the routine, so it can be shown, written in and counted as busy
// like any other, but the sidebar lists it under Routines (routines.ts), not under Recent. chat.ts draws one
// conversation; this module decides which.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type {
  AgentChange,
  Conversation,
  ConversationWatch,
  Harness,
} from "@earendil-works/pi-durable";
import {
  arr,
  bool,
  compile,
  int,
  num,
  obj,
  opt,
  str,
} from "@earendil-works/pi-schema";
import {
  type AppLabel,
  conversationState,
  lastFailed,
  firstWords,
  liveState,
  TOPIC,
  titleOf,
  withAppContext,
} from "./chat.ts";
import type { Topics } from "./live.ts";

type Id = Conversation["id"];

/** A conversation in the sidebar: what it is about, when it was last written in, and whether a routine runs in it. */
type Stored = {
  readonly id: Id;
  title: string;
  updated: number;
  routine?: boolean;
};

type Index = { current: Id; list: Stored[] };

// Open objects: a later release may keep more about a conversation than this one reads.
const stored = compile(
  obj(
    {
      current: int(),
      list: arr(
        obj(
          { id: int(), title: str(), updated: num(), routine: opt(bool()) },
          { open: true }
        )
      ),
    },
    { open: true }
  )
);

export type ChatsOptions = {
  readonly harness: Harness;
  readonly topics: Topics;
  /** The apps whose actions the transcript names. */
  readonly apps: () => readonly AppLabel[];
  readonly context: Context;
  readonly dataDir: string;
  /** The model and working directory every conversation runs with, read again on every start and switch. */
  readonly agent: () => AgentChange;
};

/** The list a file holds; none when there is no file or it does not hold one. */
function readIndex(file: string): Index | undefined {
  if (!existsSync(file)) {
    return undefined;
  }

  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf-8"));

    if (stored.check(value) && value.list.some((c) => c.id === value.current)) {
      // SAFETY: conversation ids are the harness's integers, which the file keeps as they were given.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the schema checks an integer, the brand is the harness's
      return value as Index;
    }
  } catch {
    // Not JSON: reported below like any other file that holds no list.
  }

  console.error(
    `chat: ${file} does not hold the list of conversations; starting from the first one.`
  );

  return undefined;
}

/** The conversations in use, each opened and watched from its first use, so each commit refreshes the open chats. */
function watched(options: ChatsOptions) {
  const { harness, topics, context, agent } = options;
  const opened = new Map<Id, Promise<Conversation>>();
  const watches: ConversationWatch[] = [];

  async function open(id: Id): Promise<Conversation> {
    const found = await harness.conversation(id, context);

    if (!found) {
      throw new Error(`There is no conversation ${String(id)}.`);
    }

    // root() and createConversation() apply `agent` only when they create one; a changed model or machine applies
    // from the next start.
    await found.configure(agent(), context);
    const watch = await found.watch(context);

    watch.start(async () => {
      topics.changed(TOPIC);
    });
    watches.push(watch);

    return found;
  }

  return {
    get: async (id: Id) => {
      let opening = opened.get(id);

      if (!opening) {
        opening = open(id);
        opened.set(id, opening);
        opening.catch(() => opened.delete(id));
      }

      return await opening;
    },
    /** Whether the imp is at work in any conversation in use. */
    busy: async () => {
      const states = await Promise.all(
        [...opened.keys()].map(
          async (id) => await liveState(harness, id, context)
        )
      );

      return states.some((live) => live.busy);
    },
    /** The model or machine changed: every conversation in use runs with it from its next start. */
    configure: async () => {
      await Promise.all(
        [...opened.values()].map(async (opening) => {
          await (await opening).configure(agent(), context);
        })
      );
    },
    close: async () => {
      await Promise.all(watches.map(async (watch) => await watch.stop()));
    },
  };
}

type Shared = {
  readonly options: ChatsOptions;
  readonly index: Index;
  readonly save: () => void;
  readonly conversation: (id: Id) => Promise<Conversation>;
};

/** The conversations routines run in (routines.ts): made, renamed and dropped with their routine, and run in. */
function routineConversations({ options, index, save, conversation }: Shared) {
  const { harness, topics, context, agent } = options;

  /** A routine's conversation, by the id the routine keeps. */
  const routineOf = (id: string) =>
    index.list.find((c) => String(c.id) === id && c.routine);

  return {
    /** A conversation for a routine, named by it, which the sidebar lists with the routines; answers its id. */
    async addRoutine(name: string) {
      const made = await harness.createConversation(
        { ownership: { kind: "ownerless" }, agent: agent() },
        context
      );

      index.list.push({
        id: made.id,
        title: name,
        updated: Date.now(),
        routine: true,
      });
      save();
      await conversation(made.id);

      return String(made.id);
    },
    /** A routine was renamed. */
    renameRoutine(id: string, name: string) {
      const kept = routineOf(id);

      if (kept) {
        kept.title = name;
        save();
        topics.changed(TOPIC);
      }
    },
    /** A routine was deleted: its conversation leaves the list, and the open chat moves to the latest one if it was. */
    dropRoutine(id: string) {
      index.list = index.list.filter((c) => String(c.id) !== id || !c.routine);

      if (!index.list.some((c) => c.id === index.current)) {
        const [latest] = index.list
          .filter((c) => !c.routine)
          .toSorted((a, b) => b.updated - a.updated);

        if (latest) {
          index.current = latest.id;
        }
      }

      save();
      topics.changed(TOPIC);
    },
    /** Starts a routine's run in its conversation; resolves once the run is over. */
    async runRoutine(id: string, text: string) {
      const kept = routineOf(id);

      if (!kept) {
        throw new Error("That routine's conversation is gone.");
      }

      const home = await conversation(kept.id);

      kept.updated = Date.now();
      save();
      await home.submit(
        { type: "input", content: text, whenBusy: "followUp" },
        context
      );
      await home.waitForIdle(context);
    },
    /** Waits for a run in a routine's conversation that started before the host did. */
    async settled(id: string) {
      const kept = routineOf(id);

      if (kept) {
        await (await conversation(kept.id)).waitForIdle(context);
      }
    },
    /** Whether the last run in a conversation ended with the model failing. */
    async failed(id: string) {
      const kept = index.list.find((c) => String(c.id) === id);

      return kept
        ? await lastFailed(await conversation(kept.id), context)
        : false;
    },
  };
}

export async function openChats(options: ChatsOptions) {
  const { harness, topics, context, agent } = options;
  const file = path.join(options.dataDir, "conversations.json");
  const conversations = watched(options);
  const conversation = conversations.get;

  /** The list from before there were several: the root conversation, named by its first message. */
  async function adopt(): Promise<Index> {
    const root = await harness.root(context, { agent: agent() });
    const title = await firstWords(root, context);

    return { current: root.id, list: [{ id: root.id, title, updated: 0 }] };
  }

  const index = readIndex(file) ?? (await adopt());

  const save = () => {
    writeFileSync(file, JSON.stringify(index), { mode: 0o600 });
  };

  save();
  // The open conversation is watched from the start; the others from when they are opened.
  await conversation(index.current);

  const showing = (id: Id) => {
    index.current = id;
    save();
    topics.changed(TOPIC);
  };

  return {
    /** The open conversation, and every one with something said in it, the latest written in first. */
    async state() {
      const shown = await conversationState({
        harness,
        conversation: await conversation(index.current),
        apps: options.apps(),
        context,
      });

      const open = index.list.find((c) => c.id === index.current);

      const conversations = index.list
        .filter((c) => c.title !== "" && !c.routine)
        .toSorted((a, b) => b.updated - a.updated)
        .map(({ id, title }) => ({ id: String(id), title }));

      return {
        ...shown,
        current: String(index.current),
        // The routine whose conversation is open, by name; "" for a chat.
        routine: open?.routine ? open.title : "",
        conversations,
      };
    },
    /** The open conversation's id. */
    current: () => String(index.current),
    /** Whether the imp is at work in any conversation. */
    busy: conversations.busy,
    /** The person writes in the open conversation; its first message names it in the sidebar. */
    async submit(text: string, app: AppLabel | undefined) {
      const shown = index.list.find((c) => c.id === index.current);
      const home = await conversation(index.current);

      if (shown) {
        shown.title ||= titleOf(text);
        shown.updated = Date.now();
        save();
      }

      await home.submit(
        {
          type: "input",
          content: withAppContext(text, app),
          whenBusy: "steer",
        },
        context
      );
    },
    async stop() {
      await (await conversation(index.current)).abort(context);
    },
    /** Shows another conversation. */
    async show(id: string) {
      const shown = index.list.find((c) => String(c.id) === id);

      if (!shown) {
        throw new Error("That conversation is gone.");
      }

      await conversation(shown.id);
      showing(shown.id);
    },
    /** Opens a new chat: one with nothing said in it yet, made only when there is none. */
    async fresh() {
      let blank = index.list.find((c) => c.title === "");

      if (!blank) {
        const made = await harness.createConversation(
          { ownership: { kind: "ownerless" }, agent: agent() },
          context
        );

        blank = { id: made.id, title: "", updated: Date.now() };
        index.list.push(blank);
      }

      await conversation(blank.id);
      showing(blank.id);
    },
    ...routineConversations({ options, index, save, conversation }),
    /** The model or machine changed: every conversation in use runs with it from its next start. */
    configure: conversations.configure,
    close: conversations.close,
  };
}

export type Chats = Awaited<ReturnType<typeof openChats>>;

// The person's side of the conversations: send a message, stop the imp, start a new chat, open, archive or restore
// another one. The chat itself streams on its own source (chats.ts, `state`).
import {
  type Calls,
  type LiveSource,
  ok,
  refused,
  text,
  why,
} from "../live/live.ts";
import { TOPIC } from "./chat.ts";
import type { Chats, ChatsOptions } from "./chats.ts";

/** The open conversation as the shell shows it, and the list of them. */
export const chatSource = (chats: Chats): LiveSource => ({
  topics: [TOPIC],
  load: async () => await chats.state(),
});

export type ChatCallsOptions = {
  /** Whether a model account is signed in, so a message can be answered. */
  readonly usable: () => Promise<boolean>;
  /** The apps there are, one of which may be open beside the chat. */
  readonly apps: ChatsOptions["apps"];
};

export function chatCalls(
  chats: Chats,
  { usable, apps }: ChatCallsOptions
): Calls {
  return [
    [
      "chatSend",
      async (args) => {
        const message = text(args, 0).trim();

        if (!message) {
          return refused("Write a message first.");
        }

        if (!(await usable())) {
          return refused("Sign in first.");
        }

        // The second argument is the app open beside the chat, "" from the chat tab.
        const open = apps().find((app) => app.id === args[1]);

        await chats.submit(message, open);

        return ok;
      },
    ],
    [
      "chatStop",
      async () => {
        await chats.stop();

        return ok;
      },
    ],
    [
      "chatNew",
      async () => {
        await chats.fresh();

        return ok;
      },
    ],
    [
      "chatArchive",
      async (args) => {
        try {
          await chats.archive(text(args, 0));

          return ok;
        } catch (error) {
          return refused(why(error));
        }
      },
    ],
    [
      "chatRestore",
      (args) => {
        try {
          chats.restore(text(args, 0));

          return ok;
        } catch (error) {
          return refused(why(error));
        }
      },
    ],
    [
      "chatShow",
      async (args) => {
        try {
          await chats.show(text(args, 0));

          return ok;
        } catch (error) {
          return refused(why(error));
        }
      },
    ],
  ];
}

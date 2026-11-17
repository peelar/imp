// The person's side of the conversations: send a message, stop the imp, start a new chat, open the one beside an app,
// open, archive or restore another one. The chat itself streams on its own source (chats.ts, `state`).
import {
  type Calls,
  type LiveSource,
  ok,
  refused,
  text,
  why,
} from "../live/live.ts";
import { arr, compile, lit, obj, oneOf, str } from "@earendil-works/pi-schema";
import { TOPIC } from "./chat.ts";
import type { Chats, ChatsOptions } from "./chats.ts";

const MAX_IMAGES = 4;

/**
 * The images a message carries, base64 as the model takes them, at most 5 MB each: a size the providers' APIs take
 * inline. The shell shrinks each one below it before sending.
 */
const attachedImages = compile(
  arr(
    obj({
      type: lit("image"),
      data: str({
        minLength: 1,
        maxLength: Math.ceil((5 * 1024 * 1024 * 4) / 3),
      }),
      mimeType: oneOf(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    }),
    { maxItems: MAX_IMAGES }
  )
);

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
        // The third argument is the images the person attached, as the model takes them; none from older shells.
        const images = args[2] ?? [];

        if (!attachedImages.check(images)) {
          return refused(
            `Imp takes up to ${MAX_IMAGES} PNG, JPEG, GIF or WebP images of at most 5 MB each.`
          );
        }

        if (!message && images.length === 0) {
          return refused("Write a message first.");
        }

        if (!(await usable())) {
          return refused("Sign in first.");
        }

        // The second argument is the app open beside the chat, "" from the chat tab.
        const open = apps().find((app) => app.id === args[1]);

        await chats.submit(message, open, images);

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
      // The chat for the page the person opens: beside an app, that app's (Chats' `beside`); on any other page, the
      // shell opening on it, a new chat.
      "chatBeside",
      async (args) => {
        const open = apps().find((app) => app.id === args[0]);

        await (open ? chats.beside(open.id) : chats.fresh());

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

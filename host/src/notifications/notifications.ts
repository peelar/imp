// Notifications: what needs the person, told as it happens, so they need not open Imp to find out. Each open Imp (a browser tab,
// the Mac app, the iPhone app) shows a new notice as a notification while its window is not in front; the shell reads
// them on the account stream.
//
// Three things make a notice: a routine's run that ended with something to say (not one that found nothing new), a
// key or login the imp asks for, and the imp finishing a reply in a chat. This context watches the routines, the
// secrets and the chats by their topics and decides; they know nothing of it. The host keeps the latest notices in
// memory only: a notice is news, and the conversation or Settings keeps what it was about.
import { type Chats, TOPIC as CHAT, saidNothingNew } from "../chats/chats.ts";
import type { Topics } from "../live/live.ts";
import { type Routines, TOPIC as ROUTINES } from "../routines/routines.ts";
import { type Secrets, TOPIC as SECRETS } from "../secrets/secrets.ts";

export const TOPIC = "notices";

/** How many notices the host keeps: enough for a page that missed a few while it reconnected. */
const KEPT = 20;

/** The longest body a notice has; a notification shows a few lines. */
const BODY = 180;

/**
 * A notice. `kind` is "routine" (a run ended), "key" (the imp asks for a key or login) or "reply" (the imp finished
 * replying). `conversation` is the conversation it opens ("" for a key, which Settings takes). `at` is when it was
 * posted, in milliseconds since the epoch, and grows with every notice, so a page tells the new ones by it.
 */
export type Notice = {
  readonly id: string;
  readonly kind: "routine" | "key" | "reply";
  readonly title: string;
  readonly body: string;
  readonly conversation: string;
  readonly at: number;
};

export type NotificationsOptions = {
  readonly topics: Topics;
  readonly chats: Chats;
  readonly routines: Routines;
  readonly secrets: Secrets;
};

const report = (cause: unknown) => {
  console.error(
    `notices: ${cause instanceof Error ? cause.message : String(cause)}`
  );
};

/** The start of a reply as a notification's body: its words on one line, without Markdown's marks. */
function bodyOf(text: string) {
  const words = text
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*(?:#+|>|[-*+]|\d+\.)\s+/, "")
        .replaceAll(/[*_`]+/g, "")
        .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .trim()
    )
    .filter((line) => line !== "")
    .join(" ");

  return words.length > BODY ? `${words.slice(0, BODY - 1).trimEnd()}…` : words;
}

/**
 * Calls `check` once for every burst of changes: a change while it runs asks for one more run when it ends. A chat
 * changes with every word the imp streams.
 */
function coalesced(check: () => Promise<void>) {
  let checking = false;
  let again = false;

  const run = async (): Promise<void> => {
    if (checking) {
      again = true;

      return;
    }

    checking = true;
    again = false;

    try {
      await check();
    } finally {
      checking = false;
    }

    if (again) {
      await run();
    }
  };

  return () => {
    run().catch(report);
  };
}

type Post = (notice: Omit<Notice, "id" | "at">) => void;

/** A run of a routine ended: it says what it found, or that it failed, unless it found nothing new. */
function followRoutines({ routines, chats }: NotificationsOptions, post: Post) {
  const finished = new Map(routines.list().map((r) => [r.id, r.finished]));

  return coalesced(async () => {
    const ended = routines
      .list()
      .filter((r) => r.finished > (finished.get(r.id) ?? r.finished));

    for (const r of routines.list()) {
      finished.set(r.id, r.finished);
    }

    await Promise.all(
      ended.map(async (r) => {
        const outcome = await chats.outcome(r.id);
        const text = outcome?.text ?? "";

        if (r.failed) {
          post({
            kind: "routine",
            title: r.name,
            body: bodyOf(`The run failed. ${outcome?.error ?? ""}`),
            conversation: r.id,
          });
        } else if (!saidNothingNew(text)) {
          post({
            kind: "routine",
            title: r.name,
            body: bodyOf(text) || "The run ended.",
            conversation: r.id,
          });
        }
      })
    );
  });
}

/** The imp asked for a key or a login, which only the person can add in Settings. */
function followRequests({ secrets }: NotificationsOptions, post: Post) {
  const asked = new Set(secrets.state().requests.map((r) => r.id));

  return () => {
    const { requests, services } = secrets.state();

    for (const request of requests.filter((r) => !asked.has(r.id))) {
      const label =
        services.find((s) => s.id === request.service)?.label ?? request.name;

      post({
        kind: "key",
        title:
          request.service === "login"
            ? `Your imp asks for a login for ${request.host}`
            : `Your imp asks for a ${label} key`,
        body: bodyOf(request.why),
        conversation: "",
      });
    }

    asked.clear();

    for (const request of requests) {
      asked.add(request.id);
    }
  };
}

/** The imp finished a turn in a chat: what it said, or why it stopped. A routine's runs are followRoutines'. */
function followReplies({ chats }: NotificationsOptions, post: Post) {
  let working = new Set<string>();

  return coalesced(async () => {
    const now = new Set(await chats.working());
    const ended = [...working].filter((id) => !now.has(id));

    working = now;

    await Promise.all(
      ended.map(async (id) => {
        const outcome = await chats.outcome(id);

        if (outcome && !outcome.routine) {
          post({
            kind: "reply",
            title: outcome.title || "Your imp",
            body: outcome.error
              ? bodyOf(`Your imp stopped. ${outcome.error}`)
              : bodyOf(outcome.text) || "Your imp is done.",
            conversation: id,
          });
        }
      })
    );
  });
}

export function openNotifications(options: NotificationsOptions) {
  const { topics } = options;
  let list: readonly Notice[] = [];

  const post: Post = (notice) => {
    // Strictly later than the last one, so two notices in the same millisecond are both new to a page.
    const at = Math.max(Date.now(), (list[0]?.at ?? 0) + 1);

    list = [{ ...notice, id: `${notice.kind}-${at}`, at }, ...list].slice(
      0,
      KEPT
    );
    topics.changed(TOPIC);
  };

  // For as long as the host runs, as the parts it watches do.
  topics.on(ROUTINES, followRoutines(options, post));
  topics.on(SECRETS, followRequests(options, post));
  topics.on(CHAT, followReplies(options, post));

  return {
    /** The latest notices, the newest first. */
    state: () => list,
  };
}

export type Notifications = ReturnType<typeof openNotifications>;

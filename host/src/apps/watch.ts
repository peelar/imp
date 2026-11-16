// The apps' watched URLs: the cheap half of keeping an app current. A live app's sync may name URLs that say when its
// service has something new (sdk/app.ts, `sync.watch`), such as GitHub's notifications. The host asks them itself, not
// the app's code on the computer: with the ETag and Last-Modified it saw last, as often as the service's
// X-Poll-Interval allows and at least a minute apart. An answer of nothing new (304) costs neither the service's rate
// limit nor the computer. An answer whose body differs from the last one runs the app's sync, which wakes the computer
// if it must: the sync does the expensive half.
//
// What the host saw last is kept in DATA_DIR/apps/watch.json, so a restart does not count as a change. A URL that
// fails is asked again later, twice as late each time, up to an hour.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { compile, map, obj, str } from "@earendil-works/pi-schema";
import type { FetchAnswer } from "../../../sdk/app.ts";
import type { FetchRequest } from "./protocol.ts";
import { readKept } from "../datadir/datadir.ts";

const TICK_MS = 15_000;
const MIN_POLL_MS = 60_000;
const MAX_WAIT_MS = 60 * 60_000;

/** What the host saw last at one URL. */
type Seen = {
  readonly etag: string;
  readonly lastModified: string;
  /** A hash of the body: a change is a body that differs. */
  readonly hash: string;
};

const kept = compile(
  map(map(obj({ etag: str(), lastModified: str(), hash: str() })))
);

export type WatchOptions = {
  readonly dataDir: string;
  /** The id of the app every slot runs: a slot named by it runs the live version. */
  readonly slots: () => ReadonlyMap<string, { readonly id: string }>;
  /** The URLs the version in a slot watches, as it last loaded, without reaching the machine. */
  readonly known: (
    slot: string
  ) => { readonly manifest: { readonly watch: readonly string[] } } | undefined;
  /** Sends a GET for the app in `slot`, held to its connections, with the owner's key. */
  readonly ask: (slot: string, request: FetchRequest) => Promise<FetchAnswer>;
  /** Something new at one of app `id`'s URLs: runs its sync, and answers why it failed, if it did. */
  readonly changed: (id: string) => Promise<string | undefined>;
  readonly log: (message: string) => void;
};

/** When a URL may be asked next, and how many times in a row it failed. */
type Timing = { next: number; failures: number; asking: boolean };

const why = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/** How long the service asks us to wait (X-Poll-Interval, in seconds), and never less than a minute. */
const pollMs = (answer: FetchAnswer) =>
  Math.max(
    MIN_POLL_MS,
    (Number(answer.headers["x-poll-interval"]) || 0) * 1000
  );

/** What the host saw last at each app's URLs, kept in `file`. */
function seenStore(file: string, log: (message: string) => void) {
  const seen = new Map(
    Object.entries(
      readKept(file, kept, (problem) => {
        log(`watch: ${problem}`);
      }) ?? {}
    ).map(([id, urls]) => [id, new Map(Object.entries(urls))])
  );

  return {
    get: (id: string, url: string) => seen.get(id)?.get(url),
    set: (id: string, url: string, now: Seen) => {
      seen.set(id, (seen.get(id) ?? new Map<string, Seen>()).set(url, now));
      writeFileSync(
        file,
        JSON.stringify(
          Object.fromEntries(
            [...seen].map(([app, urls]) => [app, Object.fromEntries(urls)])
          )
        )
      );
    },
  };
}

/** Asks one URL whether it changed since the host last saw it, and runs the sync if it did; answers when to ask again. */
async function askOnce(
  options: WatchOptions,
  seen: ReturnType<typeof seenStore>,
  { id, url }: { id: string; url: string }
) {
  const before = seen.get(id, url);
  const headers: Record<string, string> = {};

  if (before?.etag) {
    headers["if-none-match"] = before.etag;
  }

  if (before?.lastModified) {
    headers["if-modified-since"] = before.lastModified;
  }

  const answer = await options.ask(id, {
    op: "fetch",
    url,
    method: "GET",
    headers,
    body: "",
  });

  if (answer.status === 200) {
    const hash = createHash("sha256").update(answer.body).digest("hex");

    seen.set(id, url, {
      etag: answer.headers.etag ?? "",
      lastModified: answer.headers["last-modified"] ?? "",
      hash,
    });

    if (hash !== before?.hash) {
      await options.changed(id);
    }
  } else if (answer.status !== 304) {
    throw new Error(`${url} answered ${answer.status}`);
  }

  return pollMs(answer);
}

export function appWatch(options: WatchOptions) {
  const seen = seenStore(path.join(options.dataDir, "watch.json"), options.log);
  const timings = new Map<string, Timing>();

  /** Asks one URL, and sets when to ask it next: later after a failure, twice as late each time. */
  const ask = async (watched: { id: string; url: string }, timing: Timing) => {
    timing.asking = true;

    try {
      timing.next = Date.now() + (await askOnce(options, seen, watched));
      timing.failures = 0;
    } catch (cause) {
      timing.failures += 1;

      const wait = Math.min(MIN_POLL_MS * 2 ** timing.failures, MAX_WAIT_MS);

      timing.next = Date.now() + wait;
      options.log(
        `watch ${watched.id}: ${why(cause).replace(/\.$/, "")}; next try in ${Math.round(wait / 60_000)} min`
      );
    } finally {
      timing.asking = false;
    }
  };

  /** The live apps' watched URLs, each with a `<id> <url>` key. */
  const watched = () =>
    [...options.slots()].flatMap(([slot, app]) =>
      slot === app.id
        ? (options.known(slot)?.manifest.watch ?? []).map((url) => ({
            id: slot,
            url,
            key: `${slot} ${url}`,
          }))
        : []
    );

  const tick = () => {
    const now = Date.now();
    const current = watched();

    for (const entry of current) {
      const timing = timings.get(entry.key) ?? {
        next: now,
        failures: 0,
        asking: false,
      };

      timings.set(entry.key, timing);

      if (!timing.asking && timing.next <= now) {
        ask(entry, timing).catch((cause: unknown) => {
          options.log(`watch ${entry.id}: ${why(cause)}`);
        });
      }
    }

    // A URL no live version watches any more is forgotten.
    const keys = new Set(current.map(({ key }) => key));

    for (const key of timings.keys()) {
      if (!keys.has(key)) {
        timings.delete(key);
      }
    }
  };

  const timer = setInterval(tick, TICK_MS);

  timer.unref();

  return {
    /** Asks every watched URL that is due now; the timer does this every 15 seconds. */
    tick,
    stop: () => {
      clearInterval(timer);
    },
  };
}

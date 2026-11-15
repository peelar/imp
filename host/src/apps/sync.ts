// The apps' syncs: an app that declares `sync` (sdk/app.ts) brings outside data into its database, and the host
// decides when. A sync runs on the live version only, never on a draft, which runs on a copy of the data, and never
// wakes the computer for itself:
//
// - when the app's tab opens and its data is due for a sync (its tab reads it, which needs the computer anyway),
// - on Sync now, and
// - on schedule, only while the socket to the computer is open.
//
// The host keeps each app's sync status outside the app's database, in DATA_DIR/apps/sync.json, so an app cannot
// make it up: when it last synced, since when it has failed and why, and when it runs next. A failure is tried again
// later, twice as late each time, up to a day.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { compile, int, map, obj, str } from "@earendil-works/pi-schema";
import type { AppInfo } from "./folders.ts";
import type { Loaded } from "./manifest.ts";
import { EVERY_MS } from "./connections.ts";
import { readKept } from "../kernel/kept.ts";

/** The topic the shell's list of apps listens to for a change of a sync's status. */
export const SYNC_TOPIC = "apps:sync";

const TICK_MS = 30_000;
const MAX_WAIT_MS = 24 * 60 * 60_000;

/** One app's sync. Times are milliseconds since the epoch, 0 for never. */
type Status = {
  last: number;
  /** When the failing runs began; 0 while the last run worked. */
  failingSince: number;
  failures: number;
  error: string;
  next: number;
};

const kept = compile(
  map(
    obj({
      last: int(),
      failingSince: int(),
      failures: int(),
      error: str(),
      next: int(),
    })
  )
);

export type SyncOptions = {
  readonly dataDir: string;
  /** What every slot runs. */
  readonly slots: () => ReadonlyMap<string, AppInfo>;
  /** The version in a slot as it last loaded, without reaching the machine. */
  readonly known: (slot: string) => Loaded | undefined;
  /** Whether the computer is connected now. */
  readonly awake: () => boolean;
  /** Runs the sync of the version in a slot. */
  readonly run: (slot: string) => Promise<void>;
  readonly changed: () => void;
};

const why = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/** "just now", "5 min", "3 h", "2 days": how long ago `at` was, said as a span. */
function span(at: number, now: number) {
  const ms = now - at;

  if (ms < 60_000) {
    return "just now";
  }

  if (ms < 3_600_000) {
    return `${Math.floor(ms / 60_000)} min`;
  }

  if (ms < 86_400_000) {
    return `${Math.floor(ms / 3_600_000)} h`;
  }

  const days = Math.floor(ms / 86_400_000);

  return days === 1 ? "1 day" : `${days} days`;
}

/** The status line the app's bar shows. */
function line(status: Status | undefined, running: boolean, now: number) {
  if (running) {
    return "Syncing…";
  }

  if (!status || (status.last === 0 && status.failingSince === 0)) {
    return "Not synced yet";
  }

  if (status.failingSince > 0) {
    const since = span(status.failingSince, now);

    return `Sync failing${since === "just now" ? "" : ` for ${since}`}: ${status.error}`;
  }

  const ago = span(status.last, now);

  return `Synced ${ago === "just now" ? ago : `${ago} ago`}`;
}

export function appSync(options: SyncOptions) {
  const file = path.join(options.dataDir, "sync.json");

  const statuses = new Map<string, Status>(
    Object.entries(
      readKept(file, kept, (problem) => {
        console.error(`sync: ${problem}`);
      }) ?? {}
    )
  );

  const running = new Set<string>();

  const save = () => {
    writeFileSync(file, JSON.stringify(Object.fromEntries(statuses)));
    options.changed();
  };

  /** How often the live version of app `id` syncs, in milliseconds; undefined when it has no sync. */
  const everyMs = (id: string) => {
    const every = options.known(id)?.manifest.every;

    return every && options.slots().get(id)?.id === id
      ? EVERY_MS[every]
      : undefined;
  };

  const due = (id: string) =>
    everyMs(id) !== undefined &&
    !running.has(id) &&
    (statuses.get(id)?.next ?? 0) <= Date.now();

  /** Runs app `id`'s sync once and records how it went; the error, when it failed. */
  const sync = async (id: string) => {
    const every = everyMs(id);

    if (every === undefined) {
      return `The ${id} app has no sync.`;
    }

    if (running.has(id)) {
      return `The ${id} app is syncing already.`;
    }

    running.add(id);
    options.changed();

    let error: string | undefined;

    try {
      await options.run(id);
    } catch (cause) {
      error = why(cause);
    }

    running.delete(id);

    const now = Date.now();
    const before = statuses.get(id);

    if (error === undefined) {
      statuses.set(id, {
        last: now,
        failingSince: 0,
        failures: 0,
        error: "",
        next: now + every,
      });
    } else {
      const failures = (before?.failures ?? 0) + 1;

      statuses.set(id, {
        last: before?.last ?? 0,
        failingSince:
          before && before.failingSince > 0 ? before.failingSince : now,
        failures,
        error,
        next: now + Math.min(every * 2 ** failures, MAX_WAIT_MS),
      });
    }

    save();

    return error;
  };

  const inBackground = (id: string) => {
    sync(id).catch((cause: unknown) => {
      console.error(`sync ${id}: ${why(cause)}`);
    });
  };

  const timer = setInterval(() => {
    if (!options.awake()) {
      return;
    }

    for (const id of options.slots().keys()) {
      if (due(id)) {
        inBackground(id);
      }
    }
  }, TICK_MS);

  timer.unref();

  return {
    /** The app's tab read its data: sync it, if it is due. */
    opened: (id: string) => {
      if (due(id)) {
        inBackground(id);
      }
    },
    /** Sync now: runs it, and answers why it failed, if it did. */
    now: async (id: string) => await sync(id),
    /** What the app's bar says about its sync; "" for an app without one. */
    line: (id: string) =>
      everyMs(id) === undefined
        ? ""
        : line(statuses.get(id), running.has(id), Date.now()),
    stop: () => {
      clearInterval(timer);
    },
  };
}

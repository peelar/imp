// The imp's routines: instructions it carries out on a schedule while the person is away, such as "every weekday at
// 8, check my pull requests". The imp saves them with its tools (tools.ts); the person sees them in the
// sidebar, where they run one now, pause one or delete one. Each routine runs in a conversation of its own (kept with
// the others in chats/chats.ts), so the person can open it, read what each run found and reply, and the next run sees that.
//
// The host keeps the routines in `routines.json` in its data directory. A timer looks for a routine that is due and
// runs it once the imp is idle and signed in: one run at a time, since the imp has one computer. A run that was due
// while the host was down runs once when it is back, and a run the host restarted in the middle of finishes, since the
// harness carries it on. When a run ends the routine is marked unread until the person opens it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { arr, bool, compile, num, obj, str } from "@earendil-works/pi-schema";
import { routineRun, type Chats } from "../chats/chats.ts";
import type { Topics } from "../live/live.ts";
import {
  hostZone,
  knownZone,
  nextRun,
  parseSchedule,
  shownAt,
} from "./schedule.ts";

// What the other parts of the host use of this context's inner files (scripts/boundaries.ts).
export { routinesExtension } from "./tools.ts";

export const TOPIC = "routines";

/** How often the host looks for a routine that is due. */
const TICK_MS = 20_000;

/** The closest two runs of one routine may be, so a routine cannot spend the person's plan every minute. */
const MIN_GAP_MS = 15 * 60_000;

/** A routine as the host keeps it. Its id is its conversation's. Times are milliseconds since the epoch, 0 for never. */
type Routine = {
  readonly id: string;
  name: string;
  /** The schedule in words, as the imp wrote it, such as "Weekdays at 8:00". */
  when: string;
  /** The schedule as cron, read on the clock of `zone`. */
  schedule: string;
  zone: string;
  instruction: string;
  paused: boolean;
  /** When it runs next; 0 when its schedule names no time. */
  due: number;
  started: number;
  finished: number;
  /** Whether its last run ended with the model failing. */
  failed: boolean;
  /** Whether a run ended since the person last opened it. */
  unread: boolean;
};

// Open objects: a later release may keep more about a routine than this one reads.
const stored = compile(
  obj(
    {
      list: arr(
        obj(
          {
            id: str(),
            name: str(),
            when: str(),
            schedule: str(),
            zone: str(),
            instruction: str(),
            paused: bool(),
            due: num(),
            started: num(),
            finished: num(),
            failed: bool(),
            unread: bool(),
          },
          { open: true }
        )
      ),
    },
    { open: true }
  )
);

/** The routines a file holds; none when there is no file or it holds none. */
function readRoutines(file: string): Routine[] {
  if (!existsSync(file)) {
    return [];
  }

  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf-8"));

    if (stored.check(value)) {
      return value.list;
    }
  } catch {
    // Not JSON: reported below like any other file that holds no routines.
  }

  console.error(
    `routines: ${file} does not hold the routines; starting with none.`
  );

  return [];
}

/** What the imp asks for when it saves a routine. */
export type RoutineDraft = {
  readonly name: string;
  readonly when: string;
  readonly schedule: string;
  readonly zone?: string | undefined;
  readonly instruction: string;
};

/** The first run of a schedule after `after`; throws, saying why, for one that never runs or runs too often. */
function firstRun(schedule: string, zone: string, after: number) {
  const parsed = parseSchedule(schedule);
  const runs: number[] = [];

  for (
    let at = nextRun(parsed, zone, after);
    at !== 0 && runs.length < 24;
    at = nextRun(parsed, zone, at)
  ) {
    runs.push(at);
  }

  const [first = 0] = runs;

  if (first === 0) {
    throw new Error(`"${schedule}" never runs.`);
  }

  if (runs.some((at, i) => i > 0 && at - (runs[i - 1] ?? at) < MIN_GAP_MS)) {
    throw new Error("A routine runs at most every 15 minutes.");
  }

  return first;
}

export type RoutinesOptions = {
  readonly dataDir: string;
  readonly topics: Topics;
  readonly chats: Chats;
  /** Whether the imp can work now: the person is signed in to ChatGPT. */
  readonly ready: () => Promise<boolean>;
};

const report = (cause: unknown) => {
  console.error(
    `routines: ${cause instanceof Error ? cause.message : String(cause)}`
  );
};

/** The routines in `routines.json`, which every change writes back and announces. */
function routineStore(dataDir: string, topics: Topics) {
  const file = path.join(dataDir, "routines.json");
  let list = readRoutines(file);

  return {
    all: () => list,
    find: (id: string) => list.find((r) => r.id === id),
    named: (name: string) =>
      list.find((r) => r.name.toLowerCase() === name.toLowerCase()),
    add(routine: Routine) {
      list.push(routine);
    },
    remove(routine: Routine) {
      list = list.filter((r) => r !== routine);
    },
    save() {
      writeFileSync(file, JSON.stringify({ list }), { mode: 0o600 });
      topics.changed(TOPIC);
    },
  };
}

type Store = ReturnType<typeof routineStore>;

/** Runs what is due, one routine at a time, once the imp is free; routines asked for run first. */
function routineRunner(store: Store, { chats, ready }: RoutinesOptions) {
  const asked = new Set<string>();
  let working = false;
  let timer: NodeJS.Timeout | undefined;

  /** Runs a routine, or waits for its run that was under way when the host started, and notes how it ended. */
  async function run(routine: Routine, underWay: boolean) {
    if (!underWay) {
      routine.started = Date.now();
      routine.due = nextRun(
        parseSchedule(routine.schedule),
        routine.zone,
        routine.started
      );
      store.save();
    }

    try {
      await (underWay
        ? chats.settled(routine.id)
        : chats.runRoutine(
            routine.id,
            routineRun(routine.name, routine.instruction)
          ));
      routine.failed = await chats.failed(routine.id);
    } catch (error) {
      routine.failed = true;
      report(error);
    }

    routine.finished = Date.now();
    // Unread, unless the person watched it in the open conversation.
    routine.unread = chats.current() !== routine.id;
    store.save();
  }

  const next = () => {
    const now = Date.now();

    return (
      store.all().find((r) => asked.has(r.id)) ??
      store
        .all()
        .filter((r) => !r.paused && r.due !== 0 && r.due <= now)
        .toSorted((a, b) => a.due - b.due)[0]
    );
  };

  async function tick(): Promise<void> {
    const routine = next();

    if (working || !routine) {
      return;
    }

    working = true;
    let ran = false;

    try {
      if ((await ready()) && !(await chats.busy())) {
        asked.delete(routine.id);
        await run(routine, false);
        ran = true;
      }
    } finally {
      working = false;
    }

    // Another may have come due, or been asked for, meanwhile.
    if (ran) {
      await tick();
    }
  }

  const tickSoon = () => {
    tick().catch(report);
  };

  /** A run the host restarted in the middle of: the harness carries it on, and this waits to note how it ended. */
  async function finish(routine: Routine) {
    working = true;

    try {
      await run(routine, true);
    } finally {
      working = false;
    }

    await tick();
  }

  return {
    asked,
    start: () => {
      const underWay = store.all().find((r) => r.started > r.finished);

      if (underWay) {
        finish(underWay).catch(report);
      }

      timer = setInterval(tickSoon, TICK_MS);
      tickSoon();
    },
    /** Runs a routine as soon as the imp is free. */
    ask(id: string) {
      asked.add(id);
      tickSoon();
    },
    close: () => {
      clearInterval(timer);
    },
  };
}

/** A routine as the sidebar shows it, with its times on its own clock. */
const shown = (r: Routine, asked: ReadonlySet<string>) => ({
  id: r.id,
  name: r.name,
  when: r.when,
  instruction: r.instruction,
  next: r.paused || r.due === 0 ? "" : shownAt(r.due, r.zone),
  last: r.finished === 0 ? "" : shownAt(r.finished, r.zone),
  failed: r.failed,
  paused: r.paused,
  unread: r.unread,
  running: r.started > r.finished,
  asked: asked.has(r.id),
});

/**
 * Saves what the imp asked for: a new routine, or new words and a new schedule for the one of that name. Throws,
 * saying why, when the schedule or the time zone is not one.
 */
async function saveRoutine(store: Store, chats: Chats, draft: RoutineDraft) {
  const zone = draft.zone ?? hostZone();

  if (!knownZone(zone)) {
    throw new Error(
      `"${zone}" is not a time zone; use an IANA name such as "Europe/Warsaw".`
    );
  }

  const fields = {
    name: draft.name,
    when: draft.when,
    schedule: draft.schedule.trim(),
    zone,
    instruction: draft.instruction,
    due: firstRun(draft.schedule, zone, Date.now()),
  };

  const kept = store.named(draft.name);

  if (kept) {
    Object.assign(kept, fields);
    chats.renameRoutine(kept.id, draft.name);
  } else {
    store.add({
      id: await chats.addRoutine(draft.name),
      ...fields,
      paused: false,
      started: 0,
      finished: 0,
      failed: false,
      unread: false,
    });
  }

  store.save();

  return { next: shownAt(fields.due, zone), zone };
}

export function openRoutines(options: RoutinesOptions) {
  const { chats } = options;
  const store = routineStore(options.dataDir, options.topics);
  const runner = routineRunner(store, options);

  /** A routine the person acts on, which may be gone since their page last heard. */
  const found = (id: string) => {
    const routine = store.find(id);

    if (!routine) {
      throw new Error("That routine is gone.");
    }

    return routine;
  };

  const drop = (routine: Routine) => {
    store.remove(routine);
    runner.asked.delete(routine.id);
    chats.dropRoutine(routine.id);
    store.save();
  };

  return {
    start: runner.start,
    close: runner.close,
    /** The routines as the imp's prompt lists them. */
    list: () => store.all(),
    state: () => store.all().map((r) => shown(r, runner.asked)),
    save: async (draft: RoutineDraft) => await saveRoutine(store, chats, draft),
    /** Deletes the routine of a name, for the imp; answers whether there was one. */
    remove(name: string) {
      const kept = store.named(name);

      if (kept) {
        drop(kept);
      }

      return kept !== undefined;
    },
    // The person's changes, from the sidebar.
    runNow(id: string) {
      runner.ask(found(id).id);
      options.topics.changed(TOPIC);
    },
    pause(id: string, paused: boolean) {
      const routine = found(id);

      routine.paused = paused;
      // Resumed, it runs at its next time from now, not at the ones it missed while paused.
      routine.due = paused
        ? routine.due
        : nextRun(parseSchedule(routine.schedule), routine.zone, Date.now());
      store.save();
    },
    delete(id: string) {
      drop(found(id));
    },
    /** Opens a routine's conversation, which marks its runs read. */
    async open(id: string) {
      found(id).unread = false;
      store.save();
      await chats.show(id);
    },
  };
}

export type Routines = ReturnType<typeof openRoutines>;

// A copy of the apps' code away from the host's own folders. Every save and undo commits the live apps' code to a git
// repository in DATA_DIR/backup, a folder per app, so every version is kept for good (history.ts; Undo's
// history, which also holds the data, lasts 48 hours). Connected in Settings, the host also pushes each commit to a
// private GitHub repository of the person's, imp-apps (github.ts). Only code is backed up: the apps' data
// stays on the host.
//
// The host needs git for the history and the GitHub CLI (gh) for GitHub; Settings says which one is missing.
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compile, obj, str } from "@earendil-works/pi-schema";
import type { AppInfo } from "../apps/apps.ts";
import { backupCommands } from "./commands.ts";
import { githubSignIn, type Remote } from "./github.ts";
import { type BackupHistory, backupHistory } from "./history.ts";
import { readKept } from "../kernel/kept.ts";
import type { Topics } from "../kernel/live.ts";

export const TOPIC = "backup";

export type Backup = {
  /** Whether the host has git, which keeps the versions. */
  readonly git: boolean;
  /** GitHub: "off", "starting", "waiting" (for the person to enter `code` at `url`) or "on" (pushing to `repo`). */
  readonly status: string;
  readonly code: string;
  readonly url: string;
  /** "owner/imp-apps" while on. */
  readonly repo: string;
  /** Why connecting or the last push failed; "" when neither did. */
  readonly error: string;
  /** How many versions the history keeps. */
  readonly versions: number;
  /** Whether GitHub has the newest one. */
  readonly synced: boolean;
};

export type BackupOptions = {
  readonly dataDir: string;
  readonly topics: Topics;
  /** The live apps, whose code is backed up. */
  readonly apps: () => readonly AppInfo[];
  /** The GitHub CLI to run. Default: gh on PATH. */
  readonly gh?: string | undefined;
  readonly log?: ((message: string) => void) | undefined;
};

export type AppBackup = ReturnType<typeof appBackup>;

const remoteJson = compile(obj({ repo: str(), url: str() }));

const why = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/** A promise that settles when `work` does and never rejects. */
const ended = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch {
    // Whoever asked for the work hears of its failure; the queue only waits for it.
  }
};

/** One piece of work at a time, in the order it was asked for. */
function oneAtATime() {
  let queue = Promise.resolve();

  return async <T>(work: () => Promise<T>): Promise<T> => {
    // The queue never rejects (see `ended`), so the work runs whether the one before it worked or failed.
    const next = queue.then(work);

    queue = ended(next);

    return await next;
  };
}

/** Where the host pushes to, kept in DATA_DIR/backup.json while GitHub is connected. */
function keptRemote(file: string, log: (message: string) => void) {
  // A damaged file reads as not connected: Settings then offers to connect GitHub again.
  let remote = readKept(file, remoteJson, (problem) => {
    log(`backup: ${problem}`);
  });

  return {
    current: () => remote,
    keep: (next: Remote) => {
      remote = next;
      writeFileSync(file, JSON.stringify(next));
    },
    forget: () => {
      remote = undefined;
      rmSync(file, { force: true });
    },
  };
}

const NOT_CONNECTED = { status: "off", code: "", url: "", repo: "" };

type KeptRemote = ReturnType<typeof keptRemote>;

/** What Settings shows of the backup, which every change tells the shell about. */
function backupState(topics: Topics, remote: KeptRemote) {
  let state: Backup = {
    ...NOT_CONNECTED,
    git: false,
    status: remote.current() ? "on" : "off",
    repo: remote.current()?.repo ?? "",
    error: "",
    versions: 0,
    synced: false,
  };

  return {
    now: () => state,
    set: (next: Partial<Backup>) => {
      state = { ...state, ...next };
      topics.changed(TOPIC);
    },
  };
}

type Keeping = {
  readonly history: BackupHistory;
  readonly remote: KeptRemote;
  readonly state: ReturnType<typeof backupState>;
  readonly log: (message: string) => void;
};

/** Keeping the versions: each one committed to the history, then pushed to GitHub when it is connected. */
function versionKeeper({ history, remote, state, log }: Keeping) {
  // One change at a time: commits and pushes.
  const serial = oneAtATime();

  /** Whether the history can be kept: the host has git, and the repository is there. */
  const ready = serial(async () => {
    try {
      await history.open();
      state.set({ git: true, versions: await history.count() });

      return true;
    } catch (cause) {
      log(`backup: no history of the apps' versions: ${why(cause)}`);

      return false;
    }
  });

  /** Pushes what GitHub does not have yet; a failure is shown in Settings, and the next save tries again. */
  const push = async () => {
    const to = remote.current();

    if (!to || !(await ready) || state.now().versions === 0) {
      return;
    }

    try {
      await history.push(to.url);
      state.set({ synced: true, error: "" });
    } catch (cause) {
      state.set({
        synced: false,
        error: `Could not back up to ${to.repo}: ${why(cause)}`,
      });
    }
  };

  return {
    serial,
    push,
    /** Keeps the apps' code as it is now, and pushes it. */
    record: (summary: string) => {
      serial(async () => {
        if (!(await ready)) {
          return;
        }

        if (await history.commit(summary)) {
          state.set({ versions: await history.count(), synced: false });
        }

        await push();
      }).catch((cause: unknown) => {
        log(`backup: ${why(cause)}`);
      });
    },
  };
}

export function appBackup(options: BackupOptions) {
  const commands = backupCommands(options);
  const github = githubSignIn(commands);

  const log =
    options.log ??
    ((line: string) => {
      console.error(line);
    });

  const remote = keptRemote(path.join(options.dataDir, "backup.json"), log);
  const state = backupState(options.topics, remote);

  const keeper = versionKeeper({
    history: backupHistory({ commands, apps: options.apps }),
    remote,
    state,
    log,
  });

  /** After the sign-in: the person's repository is where the versions go, starting with the ones there are. */
  const finish = async () => {
    const found = await github.repository();

    remote.keep(found);
    state.set({ status: "on", repo: found.repo, code: "", url: "", error: "" });
    await keeper.push();
  };

  const fail = (error: string) => {
    state.set({ ...NOT_CONNECTED, error });
  };

  return {
    state: state.now,
    record: keeper.record,
    /** Keeps the apps as the host starts with them, and pushes what GitHub does not have yet. */
    start: () => {
      keeper.record("Keep the apps as the host started with them");
    },
    /** GitHub's device code sign-in: the code shows in Settings, and the person approves on any device. */
    connect: () => {
      if (state.now().status !== "off") {
        return;
      }

      state.set({ status: "starting", code: "", url: "", error: "" });
      github.start({
        onCode: (code, url) => {
          if (state.now().status === "starting") {
            state.set({ status: "waiting", code, url });
          }
        },
        onSignedIn: () => {
          keeper.serial(finish).catch((cause: unknown) => {
            fail(`Signed in to GitHub, but ${why(cause)}`);
          });
        },
        onFailed: fail,
      });
    },
    cancel: () => {
      github.stop();

      if (state.now().status !== "on") {
        fail("");
      }
    },
    /** Stops pushing and signs the host out of GitHub. The repository on GitHub stays. */
    disconnect: async () => {
      await github.signOut();
      remote.forget();
      state.set({ ...NOT_CONNECTED, error: "", synced: false });
    },
    close: github.stop,
  };
}

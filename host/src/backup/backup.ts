// A copy of the apps' code away from the host's own folders. Every save and undo commits the live apps' code to a git
// repository in DATA_DIR/backup, a folder per app, so every version is kept for good (history.ts; Undo's
// history, which also holds the data, lasts 48 hours). Turned on in Settings, under the GitHub connection
// (connections/), the host also pushes each commit to a GitHub repository of the person's, imp-apps, private unless
// they choose public when Settings asks before it is made (github.ts), through the egress proxy, which puts the github
// key on the push. Only code is backed up: the apps' data stays on the host.
//
// The host needs git for the history; Settings says when it is missing.
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compile, obj, str } from "@earendil-works/pi-schema";
import type { AppInfo } from "../apps/apps.ts";
import { backupCommands } from "./commands.ts";
import {
  type GithubApi,
  personalRepository,
  type Remote,
  type Visibility,
} from "./github.ts";
import { type BackupHistory, backupHistory } from "./history.ts";
import { readKept } from "../datadir/datadir.ts";
import type { Topics } from "../live/live.ts";

export { backupCalls } from "./shell.ts";

export type { GithubApi } from "./github.ts";

export const TOPIC = "backup";

type Backup = {
  /** Whether the host has git, which keeps the versions. */
  readonly git: boolean;
  /** GitHub: "off", "starting" (finding the repository) or "on" (pushing to `repo`). */
  readonly status: string;
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
  /** The GitHub connection the backup pushes with. */
  readonly github: {
    /** Whether GitHub is connected: the vault has the github key. */
    readonly connected: () => boolean;
    readonly api: GithubApi;
    /** The environment git pushes in: through the egress proxy, which puts the key on the push. */
    readonly pushEnv: () => Promise<Record<string, string>>;
  };
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

/** Where the host pushes to, kept in DATA_DIR/backup.json while the backup is on. */
function keptRemote(file: string, log: (message: string) => void) {
  // A damaged file reads as off: Settings then offers to turn the backup on again.
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

const NOT_CONNECTED = { status: "off", repo: "" };

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
  readonly pushEnv: () => Promise<Record<string, string>>;
  readonly remote: KeptRemote;
  readonly state: ReturnType<typeof backupState>;
  readonly log: (message: string) => void;
};

/** Keeping the versions: each one committed to the history, then pushed to GitHub when it is connected. */
function versionKeeper({ history, pushEnv, remote, state, log }: Keeping) {
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
      await history.push(to.url, await pushEnv());
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
  const { github } = options;
  const commands = backupCommands(options);

  const log =
    options.log ??
    ((line: string) => {
      console.error(line);
    });

  const remote = keptRemote(path.join(options.dataDir, "backup.json"), log);
  const state = backupState(options.topics, remote);

  const keeper = versionKeeper({
    history: backupHistory({ commands, apps: options.apps }),
    pushEnv: github.pushEnv,
    remote,
    state,
    log,
  });

  /** The person's repository is where the versions go, starting with the ones there are. */
  const finish = async (visibility: Visibility) => {
    const found = await personalRepository(github.api, visibility);

    remote.keep(found);
    state.set({ status: "on", repo: found.repo, error: "" });
    await keeper.push();
  };

  return {
    state: state.now,
    record: keeper.record,
    /** Keeps the apps as the host starts with them, and pushes what GitHub does not have yet. */
    start: () => {
      keeper.record("Keep the apps as the host started with them");
    },
    /** Starts pushing to the person's imp-apps repository on GitHub, which must be connected; a new one is made with
     * the visibility they chose. */
    turnOn: (visibility: Visibility) => {
      if (state.now().status !== "off") {
        return;
      }

      if (!github.connected()) {
        state.set({ error: "Connect GitHub first." });

        return;
      }

      state.set({ status: "starting", error: "" });
      keeper
        .serial(async () => {
          await finish(visibility);
        })
        .catch((cause: unknown) => {
          state.set({ ...NOT_CONNECTED, error: why(cause) });
        });
    },
    /** Stops pushing. The repository on GitHub stays. */
    turnOff: () => {
      remote.forget();
      state.set({ ...NOT_CONNECTED, error: "", synced: false });
    },
  };
}

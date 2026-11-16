// The apps' versions, kept for good: a git repository in DATA_DIR/backup with a folder per live app, and a commit for
// every save and undo. Only code is kept here; the apps' data stays in the host's own folders.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { APP_FILES, type AppInfo } from "../apps/apps.ts";
import type { BackupCommands } from "./commands.ts";

export type BackupHistoryOptions = {
  readonly commands: BackupCommands;
  /** The live apps, whose code is kept. */
  readonly apps: () => readonly AppInfo[];
};

export type BackupHistory = ReturnType<typeof backupHistory>;

export function backupHistory({ commands, apps }: BackupHistoryOptions) {
  const { repoDir: dir, git, run } = commands;

  /** The repository's folder as the live apps are now: a folder per app, and nothing else beside `.git`. */
  const writeApps = () => {
    for (const entry of readdirSync(dir)) {
      if (entry !== ".git") {
        rmSync(path.join(dir, entry), { recursive: true, force: true });
      }
    }

    for (const app of apps()) {
      mkdirSync(path.join(dir, app.id));

      for (const name of APP_FILES) {
        writeFileSync(path.join(dir, app.id, name), app.files[name]);
      }
    }
  };

  return {
    /** Makes the repository if it is not there yet; throws when the host has no git. */
    open: async () => {
      await run("git", ["--version"]);
      mkdirSync(dir, { recursive: true });

      if (!existsSync(path.join(dir, ".git"))) {
        await git(["init", "--quiet", "--initial-branch=main"]);
      }
    },
    /** How many versions the history keeps. */
    count: async () => {
      try {
        return Number(await git(["rev-list", "--count", "HEAD"]));
      } catch {
        // No commit yet.
        return 0;
      }
    },
    /** Commits the live apps as they are now; false when that is what the last version already holds. */
    commit: async (summary: string) => {
      writeApps();
      await git(["add", "--all"]);

      if (!(await git(["status", "--porcelain"]))) {
        return false;
      }

      await git(["commit", "--quiet", "--message", summary]);

      return true;
    },
    /** Sends every version to the repository at `url`, with git's environment for it (the egress proxy's). */
    push: async (url: string, env: Record<string, string>) => {
      await git(["push", "--quiet", url, "HEAD:refs/heads/main"], env);
    },
  };
}

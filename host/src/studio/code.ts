// The app code the host keeps for itself, under DATA_DIR/code: the versions of the apps the agent made or changed.
//
//   code/<id>/live/       the live version (an app nobody changed has none: the repository's client/apps/<id>/ is it)
//   code/<id>/draft/      the draft being previewed
//   code/<id>/history/    the versions a save replaced (history.ts)
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  APP_FILES,
  type AppFiles,
  type AppInfo,
  appInfo,
  readAppFiles,
  readApps,
} from "../apps/apps.ts";

/** The versions of an app the host keeps as a folder of their own. */
type Kept = "live" | "draft";

export type CodeFolders = ReturnType<typeof codeFolders>;

/** Writes an app's files as the folder `dir`. */
export const writeApp = (dir: string, files: AppFiles) => {
  mkdirSync(dir, { recursive: true });

  for (const name of APP_FILES) {
    writeFileSync(path.join(dir, name), files[name]);
  }
};

export function codeFolders(dataDir: string) {
  const root = path.join(dataDir, "code");

  const folder = (id: string, ...rest: string[]) =>
    path.join(root, id, ...rest);

  const drop = (id: string, kept: Kept) => {
    rmSync(folder(id, kept), { recursive: true, force: true });
  };

  return {
    /** Whether the host keeps any app code: the agent made or changed an app. */
    any: () => existsSync(root),
    /** Where the versions a save of the app replaced are kept. */
    history: (id: string) => folder(id, "history"),
    /** Makes these files the app's live version or its draft, in place of the one kept. */
    put(id: string, kept: Kept, files: AppFiles) {
      drop(id, kept);
      writeApp(folder(id, kept), files);
    },
    drop,
    /** Removes everything kept for the app: its versions and its history. */
    remove(id: string) {
      rmSync(folder(id), { recursive: true, force: true });
    },
  };
}

/** The apps the host starts with: each stored live version over the repository's, and the drafts. */
export function storedApps(
  dataDir: string,
  repoAppsDir: string,
  log: (message: string) => void
) {
  const live = new Map(readApps(repoAppsDir).map((app) => [app.id, app]));
  const drafts: AppInfo[] = [];
  const root = path.join(dataDir, "code");

  /** The version of the app kept in a folder, unless there is none or it cannot be read: the log says why. */
  const kept = (id: string, kind: Kept): AppInfo | undefined => {
    const dir = path.join(root, id, kind);

    if (!existsSync(dir)) {
      return undefined;
    }

    try {
      return appInfo(readAppFiles(dir), id);
    } catch (error) {
      log(
        `studio: skipped ${dir}: ${error instanceof Error ? error.message : String(error)}`
      );

      return undefined;
    }
  };

  for (const id of existsSync(root) ? readdirSync(root) : []) {
    const version = kept(id, "live");
    const draft = kept(id, "draft");

    if (version) {
      live.set(id, version);
    }

    if (draft) {
      drafts.push(draft);
    }
  }

  return { live: [...live.values()], drafts };
}

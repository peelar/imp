// The app code the host keeps for itself, under DATA_DIR/code: the versions of the apps the agent made or changed.
//
//   code/<id>/live/       the live version (an app nobody changed has none: the repository's client/apps/<id>/ is it)
//   code/<id>/draft/      the draft being previewed
//   code/<id>/history/    the versions a save replaced (history.ts)
//
// An app Imp ships can keep its server code: its app.json says `"server": "imp"`. Then only its screen
// (app.contract) is the person's. Every version of it the host reads, at start, in a preview and on Undo, takes
// server.ts and app.json from the repository's copy, so Imp's updates to them reach a person who changed the screen,
// and the screen they made stays theirs. A screen they never changed is the repository's, and updates with it.
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

/** The server.ts and app.json Imp keeps for an app it ships, by id. */
export type ImpServers = ReadonlyMap<string, AppFiles>;

/** The repository's apps whose server code is Imp's. */
export const impServers = (repoAppsDir: string): ImpServers =>
  new Map(
    readApps(repoAppsDir).flatMap((app) =>
      app.impServer ? [[app.id, app.files] as const] : []
    )
  );

/** An app's files with Imp's server.ts and app.json in place of its own, when Imp keeps them. */
export const withImpServer = (
  files: AppFiles,
  imp: AppFiles | undefined
): AppFiles =>
  imp
    ? { ...files, "app.json": imp["app.json"], "server.ts": imp["server.ts"] }
    : files;

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
  const imp = impServers(repoAppsDir);
  const drafts: AppInfo[] = [];
  const root = path.join(dataDir, "code");

  /** The version of the app kept in a folder, unless there is none or it cannot be read: the log says why. */
  const kept = (id: string, kind: Kept): AppInfo | undefined => {
    const dir = path.join(root, id, kind);

    if (!existsSync(dir)) {
      return undefined;
    }

    try {
      return appInfo(withImpServer(readAppFiles(dir), imp.get(id)), id);
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

// The app code the host keeps for itself, under DATA_DIR/code: the versions of the apps the agent made or changed.
//
//   code/<id>/live/       the live version
//   code/<id>/installed   an app of Imp's (below) installed as it ships: the repository's client/apps/<id>/ is it
//   code/<id>/draft/      the draft being previewed
//   code/<id>/history/    the versions a save replaced (history.ts)
//   code/<id>/uninstalled the person uninstalled the app
//
// No app runs until it is installed: by the onboarding (GitHub), from the app directory (Todos), or by a save. An app
// from the repository (client/apps) installed as anything but an app of Imp's is the person's, like the ones the imp
// builds: it runs from code/<id>/live/, and Imp's updates to it no longer reach it.
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

/** The files that say an app of Imp's runs as the repository has it, and that the person uninstalled an app. */
const INSTALLED = "installed";
const UNINSTALLED = "uninstalled";

/** The repository's apps, by id: the ones the person can install as Imp ships them. */
export const shippedApps = (
  repoAppsDir: string
): ReadonlyMap<string, AppFiles> =>
  new Map(readApps(repoAppsDir).map((app) => [app.id, app.files] as const));

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

  const mark = (id: string, file: string) => {
    markApp(root, id, file);
  };

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
    /** Installs an app of Imp's as the repository has it, in place of anything kept for it. */
    installShipped: (id: string) => {
      mark(id, INSTALLED);
    },
    /** Removes everything kept for the app, and remembers that the person does not want it. */
    uninstall: (id: string) => {
      mark(id, UNINSTALLED);
    },
  };
}

/** Says one thing about the app under code/<id>/, in place of anything kept for it. */
function markApp(root: string, id: string, file: string) {
  rmSync(path.join(root, id), { recursive: true, force: true });
  mkdirSync(path.join(root, id), { recursive: true });
  writeFileSync(path.join(root, id, file), "");
}

export type StoredAppsOptions = {
  readonly dataDir: string;
  readonly repoAppsDir: string;
  /** Whether the app has data on the host. */
  readonly hasData: (id: string) => boolean;
  readonly log: (message: string) => void;
};

/** The apps the host starts with: the installed ones, each in its live version, and the drafts. */
export function storedApps({
  dataDir,
  repoAppsDir,
  hasData,
  log,
}: StoredAppsOptions) {
  const repo = readApps(repoAppsDir);
  const root = path.join(dataDir, "code");

  // Every host used to run the repository's apps uninstalled. One that ran such an app before apps had to be
  // installed has its data, and keeps it installed: an app of Imp's as the repository has it, any other as its own.
  for (const app of repo) {
    if (hasData(app.id) && !existsSync(path.join(root, app.id))) {
      if (app.impServer) {
        markApp(root, app.id, INSTALLED);
      } else {
        writeApp(path.join(root, app.id, "live"), app.files);
      }
    }
  }

  const live = new Map(
    repo
      .filter(
        (app) => app.impServer && existsSync(path.join(root, app.id, INSTALLED))
      )
      .map((app) => [app.id, app])
  );

  const imp = impServers(repoAppsDir);
  const drafts: AppInfo[] = [];

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

// The versions a save replaced, which Undo restores: every one for 48 hours, and the newest one for as long as it is
// the newest.
//
//   code/<id>/history/<ms>/         one saved-over version, named by when the save happened
//     code/                         its files; none when the save made the app
//     data.sqlite                   the app's data as the save found it; none when the app had no data
//     meta.json                     { schema: how many migrations that data had }
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { compile, int, obj } from "@earendil-works/pi-schema";
import type { AppData } from "./app-data.ts";
import type { AppFiles } from "./app-folders.ts";
import { type CodeFolders, writeApp } from "./studio-code.ts";

const HISTORY_MS = 48 * 3_600_000;

const metaJson = compile(obj({ schema: int() }));

export type VersionHistoryOptions = {
  readonly folders: CodeFolders;
  /** Each slot's data: a saved-over version keeps a copy of the live data. */
  readonly data: AppData;
};

/** A saved-over version. */
export type SavedOver = {
  readonly dir: string;
  /** How many migrations the app's data had. */
  readonly schema: number;
  /** The version's files, as a folder; undefined when the save made the app. */
  readonly code: string | undefined;
  /** The copy of the app's data. */
  readonly data: string;
};

export type VersionHistory = ReturnType<typeof versionHistory>;

/** What meta.json says, which the host wrote; throws when the file is missing, is not JSON or says something else. */
function readMeta(file: string) {
  const meta: unknown = JSON.parse(readFileSync(file, "utf-8"));

  if (!metaJson.check(meta)) {
    throw new Error(
      `${file} does not say how many migrations the saved-over data had.`
    );
  }

  return meta;
}

export function versionHistory(options: VersionHistoryOptions) {
  const { folders, data } = options;

  /** The app's saved-over versions, oldest first. */
  const entries = (id: string) => {
    const dir = folders.history(id);

    return existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => /^\d+$/.test(name))
          .sort((a, b) => Number(a) - Number(b))
      : [];
  };

  return {
    /** The version the app's last save replaced, if any. */
    latest(id: string): SavedOver | undefined {
      const entry = entries(id).at(-1);

      if (entry === undefined) {
        return undefined;
      }

      const dir = path.join(folders.history(id), entry);
      const code = path.join(dir, "code");

      return {
        dir,
        schema: readMeta(path.join(dir, "meta.json")).schema,
        code: existsSync(code) ? code : undefined,
        data: path.join(dir, "data.sqlite"),
      };
    },
    /**
     * Keeps the app's live version, files and data, before a save replaces it. `live` is undefined when the save makes
     * the app: the entry then says only that there was nothing. Answers where the entry and its copy of the data are.
     */
    keep(id: string, live: AppFiles | undefined) {
      const dir = path.join(folders.history(id), String(Date.now()));
      const copy = path.join(dir, "data.sqlite");

      mkdirSync(dir, { recursive: true });

      if (live) {
        writeApp(path.join(dir, "code"), live);
        data.copyTo(id, copy);
      }

      writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify({ schema: data.schemaVersion(id) })
      );

      return { dir, data: copy };
    },
    /** Forgets one saved-over version: the save failed, or Undo restored it. */
    forget(entry: { readonly dir: string }) {
      rmSync(entry.dir, { recursive: true, force: true });
    },
    /** Keeps every saved-over version for 48 hours, and the newest one longer. */
    prune(id: string) {
      for (const entry of entries(id).slice(0, -1)) {
        if (Date.now() - Number(entry) > HISTORY_MS) {
          rmSync(path.join(folders.history(id), entry), {
            recursive: true,
            force: true,
          });
        }
      }
    },
  };
}

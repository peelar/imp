// An app on disk: a folder of three files (app.json, app.contract, server.ts) named by the app's id.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { compile, obj, opt, str } from "@earendil-works/pi-schema";

/**
 * Names the shell's own sources and calls start with (see shell-api.ts), so no app may take them as its id: the
 * shell's `chatSend` would otherwise also name the chat app's `send`.
 */
const RESERVED = new Set([
  "chat",
  "routines",
  "account",
  "shell",
  "apps",
  "machine",
  "computer",
  "build",
  "version",
  "settings",
  "memory",
  "secrets",
  "backup",
]);

/** App ids: lowercase letters and digits, so `todosSetDone` splits into the app and its operation. */
export const APP_ID = /^[a-z][a-z0-9]*$/;

export const APP_FILES = ["app.json", "app.contract", "server.ts"] as const;

/** The files of an app's folder. */
export type AppFiles = Readonly<Record<(typeof APP_FILES)[number], string>>;

export type AppInfo = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** The app's icon in the shell, a `symbol:` source. */
  readonly symbol: string;
  /** The app's engraved cover in the shell, a client asset path such as "assets/art/todos.jpg"; "" for none. */
  readonly cover: string;
  /**
   * Whether its server.ts and app.json are Imp's (`"server": "imp"` in app.json): an app Imp ships whose screen is
   * the person's to change, and whose server code Imp's updates replace (studio/code.ts).
   */
  readonly impServer: boolean;
  readonly files: AppFiles;
  /** server.ts without its types: what the worker runs. */
  readonly code: string;
  readonly hash: string;
};

const appJson = compile(
  obj(
    {
      id: str(),
      name: opt(str()),
      description: opt(str()),
      symbol: opt(str()),
      cover: opt(str()),
      server: opt(str()),
    },
    { open: true }
  )
);

/** Where an app's draft runs. */
export const draftSlot = (id: string) => `${id}~draft`;

/** Where a version is tried before it becomes the draft. */
export const checkSlot = (id: string) => `${id}~check`;

/** The topic the app's open views listen to: anything that may change what the app answers tells it. */
export const appTopic = (id: string) => `app:${id}`;

const why = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/** An app from its files; throws with what to fix when app.json or server.ts is wrong. */
export function appInfo(files: AppFiles, id: string): AppInfo {
  const meta = readAppJson(files["app.json"], id);
  let code: string;

  try {
    code = stripTypeScriptTypes(files["server.ts"], { mode: "strip" });
  } catch (error) {
    throw new Error(`apps/${id}/server.ts does not parse: ${why(error)}`, {
      cause: error,
    });
  }

  return {
    id,
    name: meta.name === undefined || meta.name === "" ? id : meta.name,
    description: meta.description ?? "",
    symbol: meta.symbol?.startsWith("symbol:") ? meta.symbol : "symbol:layers",
    cover:
      meta.cover && /^assets\/[\w/.-]+$/.test(meta.cover) ? meta.cover : "",
    impServer: meta.server === "imp",
    files,
    code,
    hash: createHash("sha256").update(code).digest("hex").slice(0, 16),
  };
}

function readAppJson(text: string, id: string) {
  let meta: unknown;

  try {
    meta = JSON.parse(text);
  } catch (error) {
    throw new Error(`apps/${id}/app.json is not JSON: ${why(error)}`, {
      cause: error,
    });
  }

  const checked = appJson.validate(meta);

  if (!checked.ok) {
    const problems = checked.errors.map(
      (error) => `${error.path || "app.json"}: ${error.message}`
    );

    throw new Error(
      `apps/${id}/app.json must be an object with the texts id, name, description, symbol and cover: ${problems.join("; ")}.`
    );
  }

  if (checked.value.id !== id || !APP_ID.test(id) || RESERVED.has(id)) {
    throw new Error(
      `apps/${id}/app.json's id must be "${id}", the folder's name: lowercase letters and digits, and not ${[...RESERVED].join(", ")}.`
    );
  }

  return checked.value;
}

/** The files of the app folder at `folder`. */
export const readAppFiles = (folder: string): AppFiles => ({
  "app.json": readFileSync(path.join(folder, "app.json"), "utf-8"),
  "app.contract": readFileSync(path.join(folder, "app.contract"), "utf-8"),
  "server.ts": readFileSync(path.join(folder, "server.ts"), "utf-8"),
});

/** Reads every app folder under `dir`. */
export function readApps(dir: string): AppInfo[] {
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      appInfo(readAppFiles(path.join(dir, entry.name)), entry.name)
    );
}

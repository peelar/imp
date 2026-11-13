// The app gateway. Every app is a folder (app.json, app.contract, server.ts). Its server code runs in a worker on the
// agent's machine, reached over one WebSocket the host opens to agentd; its data is a SQLite database here on the
// host, which the worker reads and writes through that socket. An app declares operations (see sdk/app.ts); the
// shell's views call them by position, and the agent finds and runs them by name through two tools, so its tool list
// stays the same whichever apps are installed. Every write tells the open views to refresh.
//
// Versions run in slots. An app's live version runs in the slot named by its id; a draft being previewed runs beside
// it in `<id>~draft`, on a copy of the live data, and the shell's views use the draft while there is one. The agent's
// actions always reach the live version unless they ask for the draft.
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  defineExtension,
  defineTool,
  type Registry,
  section,
} from "@earendil-works/pi-durable";
import {
  bool,
  compile,
  int,
  map,
  num,
  obj,
  oneOf,
  opt,
  type Properties,
  type Schema,
  str,
  unknown,
  type Validator,
} from "@earendil-works/pi-schema";
import WebSocket from "ws";
import type { Topics } from "./live.ts";
import type { Machine } from "./machine.ts";
import { type DbRequest, type FromAgentd, fromAgentdCheck } from "./protocol.ts";

/** Names the shell's own sources use, so no app may take them as its id. */
const RESERVED = new Set([
  "chat",
  "account",
  "shell",
  "apps",
  "machine",
  "build",
  "settings",
  "memory",
]);

const CALL_TIMEOUT_MS = 60_000;

/** How many actions one search returns at most. */
const FOUND = 20;

/** Operation and parameter names: camelCase, so the shell's `todosSetDone` names the todos app's `setDone`. */
const NAME = /^[a-z][A-Za-z0-9]*$/;

/** App ids: lowercase letters and digits, so `todosSetDone` splits into the app and its operation. */
export const APP_ID = /^[a-z][a-z0-9]*$/;

/** The files of an app's folder. */
export type AppFiles = {
  readonly "app.json": string;
  readonly "app.contract": string;
  readonly "server.ts": string;
};

export const APP_FILES = ["app.json", "app.contract", "server.ts"] as const;

export type AppInfo = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** The app's icon in the shell, a `symbol:` source. */
  readonly symbol: string;
  /** The app's engraved cover in the shell, a client asset path such as "assets/art/todos.jpg"; "" for none. */
  readonly cover: string;
  readonly files: AppFiles;
  /** server.ts without its types: what the worker runs. */
  readonly code: string;
  readonly hash: string;
};

type Param =
  | {
      type: "string" | "number" | "integer" | "boolean";
      description?: string;
      optional?: boolean;
    }
  | {
      type: "enum";
      values: string[];
      description?: string;
      optional?: boolean;
    };

/** An operation as the worker reports it; checked on load (see `checkManifest`). */
export type Operation = {
  name: string;
  kind: "read" | "write";
  description: string;
  params: Record<string, Param>;
  /** Whether the agent may find and run it. */
  agent: boolean;
};

export type Manifest = {
  schema: string[];
  operations: Operation[];
};

/** A loaded version of an app: its manifest, and each operation with the check for its arguments. */
type Loaded = {
  readonly manifest: Manifest;
  readonly operations: ReadonlyMap<
    string,
    { readonly operation: Operation; readonly args: Validator }
  >;
};

/** Where an app's draft runs. */
export const draftSlot = (id: string) => `${id}~draft`;

/** Where a version is tried before it becomes the draft. */
export const checkSlot = (id: string) => `${id}~check`;

/** An app from its files; throws with what to fix when app.json is wrong. */
export function appInfo(files: AppFiles, id: string): AppInfo {
  let meta: {
    id?: unknown;
    name?: unknown;
    description?: unknown;
    symbol?: unknown;
    cover?: unknown;
  };

  try {
    meta = JSON.parse(files["app.json"]);
  } catch (error) {
    throw new Error(
      `apps/${id}/app.json is not JSON: ${error instanceof Error ? error.message : error}`,
      { cause: error }
    );
  }

  if (meta.id !== id || !APP_ID.test(id) || RESERVED.has(id)) {
    throw new Error(
      `apps/${id}/app.json's id must be "${id}", the folder's name: lowercase letters and digits, and not ${[...RESERVED].join(", ")}.`
    );
  }

  let code: string;

  try {
    code = stripTypeScriptTypes(files["server.ts"], { mode: "strip" });
  } catch (error) {
    throw new Error(
      `apps/${id}/server.ts does not parse: ${error instanceof Error ? error.message : error}`,
      { cause: error }
    );
  }

  const text = (value: unknown) => (typeof value === "string" ? value : "");

  return {
    id,
    name: text(meta.name) || id,
    description: text(meta.description),
    symbol: text(meta.symbol).startsWith("symbol:")
      ? text(meta.symbol)
      : "symbol:layers",
    cover: /^assets\/[\w/.-]+$/.test(text(meta.cover)) ? text(meta.cover) : "",
    files,
    code,
    hash: createHash("sha256").update(code).digest("hex").slice(0, 16),
  };
}

/** The files of the app folder at `folder`. */
export const readAppFiles = (folder: string): AppFiles =>
  Object.fromEntries(
    APP_FILES.map((name) => [name, readFileSync(join(folder, name), "utf-8")])
  ) as unknown as AppFiles;

/** Reads every app folder under `dir`. */
export function readApps(dir: string): AppInfo[] {
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => appInfo(readAppFiles(join(dir, entry.name)), entry.name));
}

export type GatewayOptions = {
  /** The live apps to start with. */
  readonly apps: readonly AppInfo[];
  readonly dataDir: string;
  readonly topics: Topics;
  readonly registry: Registry;
  readonly machine: () => Promise<Machine>;
  readonly log?: (message: string) => void;
};

export function appGateway(options: GatewayOptions) {
  const log =
    options.log ??
    ((message) => {
      console.log(message);
    });

  /** Slot -> the version that runs there. */
  const slots = new Map<string, AppInfo>(
    options.apps.map((app) => [app.id, app])
  );

  const dataDir = join(options.dataDir, "apps");
  mkdirSync(dataDir, { recursive: true });
  const dataPath = (slot: string) => join(dataDir, `${slot}.sqlite`);
  const databases = new Map<string, DatabaseSync>();

  const database = (slot: string) => {
    let db = databases.get(slot);

    if (!db) {
      databases.set(slot, (db = new DatabaseSync(dataPath(slot))));
    }

    return db;
  };

  const closeData = (slot: string) => {
    databases.get(slot)?.close();
    databases.delete(slot);
  };

  const removeData = (slot: string) => {
    closeData(slot);

    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(`${dataPath(slot)}${suffix}`, { force: true });
    }
  };

  /** The live and draft slots: the ones the shell and the agent reach (a check slot is the host's own). */
  const live = () =>
    [...slots].filter(([slot, app]) => slot === app.id).map(([, app]) => app);

  const reachable = (id: string) => slots.has(id) || slots.has(draftSlot(id));

  let socket: WebSocket | undefined;
  let connecting: Promise<WebSocket> | undefined;
  /** Per slot: the version loaded on the machine. */
  const loaded = new Map<string, Loaded>();
  /** Per slot: why its current version failed to load on this connection. */
  const failures = new Map<string, Error>();

  const loadWaiters = new Map<
    string,
    { resolve: (l: Loaded) => void; reject: (e: Error) => void }[]
  >();

  const calls = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  const sendLoad = (ws: WebSocket, slot: string, app: AppInfo) => {
    ws.send(
      JSON.stringify({ t: "load", app: slot, hash: app.hash, code: app.code })
    );
  };

  async function connect(): Promise<WebSocket> {
    if (socket?.readyState === WebSocket.OPEN) {
      return socket;
    }

    return await (connecting ??= (async () => {
      const endpoint = await (await options.machine()).appSocket();

      const ws = new WebSocket(endpoint.url, {
        headers: { ...endpoint.headers },
        maxPayload: 64 * 1024 * 1024,
      });

      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      ws.on("message", (data) => {
        const message: unknown = JSON.parse(String(data));

        if (fromAgentdCheck.check(message)) {
          onMessage(ws, message);
        } else {
          log(`app socket: dropped a message agentd should not send`);
        }
      });
      ws.on("close", () => {
        onClose(ws);
      });
      ws.on("error", (error) => {
        log(`app socket: ${error.message}`);
      });
      socket = ws;

      // The machine's processes may not survive: load every app on every connection. agentd skips an unchanged one.
      for (const [slot, app] of slots) {
        sendLoad(ws, slot, app);
      }

      return ws;
    })().finally(() => {
      connecting = undefined;
    }));
  }

  function onClose(ws: WebSocket) {
    if (socket !== ws) {
      return;
    }

    socket = undefined;
    loaded.clear();
    failures.clear();

    const lost = new Error(
      "The connection to the agent's machine was lost; try again."
    );

    for (const [id, call] of calls) {
      clearTimeout(call.timer);
      call.reject(lost);
      calls.delete(id);
    }

    for (const [slot, waiters] of loadWaiters) {
      for (const waiter of waiters) {
        waiter.reject(lost);
      }

      loadWaiters.delete(slot);
    }
  }

  function onMessage(ws: WebSocket, message: FromAgentd) {
    if (message.t === "loaded") {
      const app = slots.get(message.app);

      if (!app || app.hash !== message.hash) {
        return;
      }

      let version: Loaded;

      try {
        version = checkManifest(app.id, message.manifest as Manifest);
        migrate(message.app, app.id, version.manifest.schema);
      } catch (error) {
        settleLoad(
          message.app,
          error instanceof Error ? error : new Error(String(error))
        );

        return;
      }

      loaded.set(message.app, version);
      settleLoad(message.app, version);
      // A new version may answer differently: refresh the app's open views.
      options.topics.changed(`app:${app.id}`);
    } else if (message.t === "loadFailed") {
      const app = slots.get(message.app);

      if (!app || app.hash !== message.hash) {
        return;
      }

      log(`app ${message.app} failed to load: ${message.error}`);
      settleLoad(
        message.app,
        new Error(
          `The ${app.id} app's server.ts failed to start: ${message.error.split("\n")[0]}`
        )
      );
    } else if (message.t === "result") {
      const call = calls.get(message.id);

      if (!call) {
        return;
      }

      calls.delete(message.id);
      clearTimeout(call.timer);

      if (message.ok) {
        call.resolve(message.value);
      } else {
        call.reject(new Error(message.error || "The app failed."));
      }
    } else if (message.t === "db") {
      let reply: object;

      try {
        reply = {
          t: "dbResult",
          id: message.id,
          ok: true,
          value: runDb(message.app, message.request),
        };
      } catch (error) {
        reply = {
          t: "dbResult",
          id: message.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      ws.send(JSON.stringify(reply));
    }
  }

  function settleLoad(slot: string, result: Loaded | Error) {
    if (result instanceof Error) {
      failures.set(slot, result);
    } else {
      failures.delete(slot);
    }

    for (const waiter of loadWaiters.get(slot) ?? []) {
      if (result instanceof Error) {
        waiter.reject(result);
      } else {
        waiter.resolve(result);
      }
    }

    loadWaiters.delete(slot);
  }

  function runDb(slot: string, message: DbRequest) {
    const app = slots.get(slot);

    if (!app) {
      throw new Error(`no app ${slot}`);
    }

    const db = database(slot);
    const before = totalChanges(db);

    const run = (sql: string, params: SQLInputValue[] = []) => {
      const result = db.prepare(sql).run(...params);

      return {
        changes: Number(result.changes),
        lastInsertRowid: Number(result.lastInsertRowid),
      };
    };

    let value: unknown;

    if (message.op === "batch") {
      db.exec("BEGIN");

      try {
        value = message.statements.map((statement) =>
          run(statement.sql, statement.params)
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } else if (message.op === "all") {
      value = db.prepare(message.sql).all(...message.params);
    } else if (message.op === "get") {
      value = db.prepare(message.sql).get(...message.params) ?? null;
    } else {
      value = run(message.sql, message.params);
    }

    if (totalChanges(db) !== before) {
      options.topics.changed(`app:${app.id}`);
    }

    return value;
  }

  /** Applies the migrations a slot's database has not had yet, in one transaction. */
  function migrate(slot: string, id: string, schema: readonly string[]) {
    const db = database(slot);
    const version = schemaVersion(slot);

    if (version > schema.length) {
      throw new Error(
        `The ${id} app's data has ${version} migrations, but this version of the app has only ${schema.length}. Keep every migration and add new ones at the end.`
      );
    }

    if (version === schema.length) {
      return;
    }

    db.exec("BEGIN");

    try {
      for (const sql of schema.slice(version)) {
        db.exec(sql);
      }

      db.exec(`PRAGMA user_version = ${schema.length}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(
        `The ${id} app's migrations failed: ${error instanceof Error ? error.message : error}`,
        { cause: error }
      );
    }
  }

  const schemaVersion = (slot: string) =>
    Number(
      (
        database(slot).prepare("PRAGMA user_version").get() as {
          user_version: number;
        }
      ).user_version
    );

  async function ready(
    slot: string
  ): Promise<{ ws: WebSocket; version: Loaded }> {
    const ws = await connect();
    const failure = failures.get(slot);

    if (failure) {
      throw failure;
    }

    const version =
      loaded.get(slot) ??
      (await new Promise<Loaded>((resolve, reject) => {
        const waiters = loadWaiters.get(slot) ?? [];
        waiters.push({ resolve, reject });
        loadWaiters.set(slot, waiters);
      }));

    return { ws, version };
  }

  /** Runs an operation in a slot with named arguments, checked against its params. */
  async function run(
    slot: string,
    name: string,
    args: Record<string, unknown>,
    who: { kind?: Operation["kind"]; agent?: boolean } = {}
  ) {
    const app = slots.get(slot);

    if (!app) {
      throw new Error(`There is no ${slot.replace("~draft", " draft")} app.`);
    }

    const { id } = app;
    const { ws, version } = await ready(slot);
    const entry = version.operations.get(name);

    if (!entry) {
      throw new Error(`The ${id} app has no operation named ${name}.`);
    }

    if (who.kind && entry.operation.kind !== who.kind) {
      throw new Error(
        `The ${id} app's ${name} is a ${entry.operation.kind}, not a ${who.kind}.`
      );
    }

    if (who.agent && !entry.operation.agent) {
      throw new Error(`The ${id} app keeps ${name} from the agent.`);
    }

    const errors = entry.args.errors(args);

    if (errors.length > 0) {
      const why = errors
        .map((e) => `${e.path || "args"}: ${e.message}`)
        .join("; ");

      throw new Error(
        `The ${id} app's ${name} was called with arguments it does not take: ${why}.`
      );
    }

    const callId = randomUUID();

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        calls.delete(callId);
        reject(
          new Error(
            `The ${id} app did not answer ${name} within ${CALL_TIMEOUT_MS / 1000} s.`
          )
        );
      }, CALL_TIMEOUT_MS);

      calls.set(callId, { resolve, reject, timer });
      ws.send(JSON.stringify({ t: "call", id: callId, app: slot, name, args }));
    });
  }

  /**
   * Runs an operation the shell names, such as `todosSetDone(id, done)`, in the version the shell shows: the draft
   * while there is one. Its arguments come in the order of the operation's params. A live view only reads and a
   * press only writes, so a view never runs a write on refresh. A write answers the shell's Reply, `{ ok, error }`,
   * whatever the operation returns, unless it returns one itself.
   */
  async function fromShell(
    id: string,
    kind: Operation["kind"],
    name: string,
    positional: readonly unknown[]
  ) {
    const slot = slots.has(draftSlot(id)) ? draftSlot(id) : id;

    if (!slots.has(slot)) {
      throw new Error(`There is no ${id} app.`);
    }

    const operation = (await ready(slot)).version.operations.get(
      name
    )?.operation;

    const params = Object.keys(operation?.params ?? {});

    if (operation && positional.length > params.length) {
      throw new Error(
        `The ${id} app's ${name} takes ${params.length} argument${params.length === 1 ? "" : "s"}, not ${positional.length}.`
      );
    }

    const args: Record<string, unknown> = {};
    positional.forEach((value, i) => {
      if (value !== undefined) {
        args[params[i]] = value;
      }
    });
    const value = await run(slot, name, args, { kind });

    if (kind === "read") {
      return value;
    }

    const reply = value as { ok?: unknown; error?: unknown } | null;

    return typeof reply?.ok === "boolean"
      ? {
          ok: reply.ok,
          error: typeof reply.error === "string" ? reply.error : "",
        }
      : { ok: true, error: "" };
  }

  /** The app and the operation name of a shell source such as `todosSetDone`, if an app owns it. */
  function route(source: string): { app: string; name: string } | undefined {
    for (const app of slots.values()) {
      const rest = source.slice(app.id.length);

      if (
        source.startsWith(app.id) &&
        /^[A-Z]/.test(rest) &&
        reachable(app.id)
      ) {
        return { app: app.id, name: rest[0].toLowerCase() + rest.slice(1) };
      }
    }

    return undefined;
  }

  /** The agent's live actions that match `query`, best first, and why any app could not be searched. */
  async function find(query: string) {
    const settled = await Promise.allSettled(
      live().map(async (app) => ({
        app,
        version: (await ready(app.id)).version,
      }))
    );

    const words = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);

    const found: { score: number; action: object }[] = [];
    const problems: string[] = [];

    for (const result of settled) {
      if (result.status === "rejected") {
        problems.push(
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
        );
        continue;
      }

      const { app, version } = result.value;

      for (const { operation } of version.operations.values()) {
        if (!operation.agent) {
          continue;
        }

        const haystack = [
          app.id,
          app.name,
          app.description,
          spaced(operation.name),
          operation.description,
          ...Object.keys(operation.params).map(spaced),
        ]
          .join(" ")
          .toLowerCase();

        const score = words.filter((word) => haystack.includes(word)).length;

        if (words.length > 0 && score === 0) {
          continue;
        }

        const { name, kind, description, params } = operation;
        found.push({
          score,
          action: { app: app.id, action: name, kind, description, params },
        });
      }
    }

    found.sort((a, b) => b.score - a.score);

    return { actions: found.slice(0, FOUND).map((f) => f.action), problems };
  }

  const text = (value: unknown) => ({
    output: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value),
      },
    ],
  });

  // The agent's tools are the same two whichever apps are installed; the section lists the apps so it knows to look.
  options.registry.install(
    defineExtension({
      name: "apps",
      sections: [
        section("apps", () => {
          const list = live().map(
            (app) =>
              `- ${app.name} (${app.id})${app.description ? `: ${app.description}` : ""}`
          );

          return list.length === 0
            ? "The user has no apps yet."
            : `The user's apps:\n${list.join("\n")}\nTo use one, find what it can do with find_app_actions, then do it with run_app_action. The user sees every change in the app at once.`;
        }),
      ],
      tools: [
        defineTool({
          name: "find_app_actions",
          description:
            'Search what the user\'s apps can do, by keywords such as "add todo". An empty query lists every action. Each result names the app, the action, whether it reads or writes, and its params.',
          parameters: obj({
            query: opt(
              str({ description: "Keywords; empty lists every action." })
            ),
          }),
          execute: async ({ query }: { query?: string }) => {
            const { actions, problems } = await find(query ?? "");

            if (actions.length === 0 && problems.length === 0) {
              return text(
                query
                  ? `No action matches "${query}". Try other words, or an empty query to list every action.`
                  : "No app has any actions."
              );
            }

            return text(problems.length > 0 ? { actions, problems } : actions);
          },
        }),
        defineTool({
          name: "run_app_action",
          description:
            "Run an action find_app_actions returned, in the user's app. `args` holds its params by name. A write changes the user's data, which they see at once. With `draft: true` it runs in the app's draft instead, on the preview's copy of the data.",
          parameters: obj({
            app: str({ description: 'The app\'s id, such as "todos".' }),
            action: str({ description: 'The action\'s name, such as "add".' }),
            args: opt(
              map(unknown(), { description: "The action's params by name." })
            ),
            draft: opt(
              bool({
                description:
                  "Run it in the app's draft (its preview) instead of the saved app.",
              })
            ),
          }),
          execute: async ({
            app,
            action,
            args,
            draft,
          }: {
            app: string;
            action: string;
            args?: Record<string, unknown>;
            draft?: boolean;
          }) =>
            text(
              await run(draft ? draftSlot(app) : app, action, args ?? {}, {
                agent: true,
              })
            ),
        }),
      ],
    })
  );

  return {
    /** Every app the shell or the agent can reach, live or only a draft so far: the draft's name when it has one. */
    apps: () => {
      const shown = new Map<string, AppInfo>();

      for (const [slot, app] of slots) {
        if (slot === draftSlot(app.id)) {
          shown.set(app.id, app);
        } else if (slot === app.id && !shown.has(app.id)) {
          shown.set(app.id, app);
        }
      }

      return [...shown.values()].map(
        ({ id, name, description, symbol, cover }) => ({
          id,
          name,
          description,
          symbol,
          cover,
        })
      );
    },
    /** The version in a slot, if any. */
    version: (slot: string) => slots.get(slot),
    /** The manifest of the version in a slot, once it loaded. */
    manifest: async (slot: string) => (await ready(slot)).version.manifest,
    /** Starts `app` in `slot`, replacing what ran there, and answers its manifest once it loaded and migrated. */
    async install(slot: string, app: AppInfo): Promise<Manifest> {
      slots.set(slot, app);
      loaded.delete(slot);
      failures.delete(slot);

      if (socket?.readyState === WebSocket.OPEN) {
        sendLoad(socket, slot, app);
      }

      return (await ready(slot)).version.manifest;
    },
    /** Stops whatever runs in `slot`. Its data stays unless `removeData` is called. */
    uninstall(slot: string) {
      const app = slots.get(slot);
      slots.delete(slot);
      loaded.delete(slot);
      failures.delete(slot);

      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ t: "unload", app: slot }));
      }

      closeData(slot);

      if (app) {
        options.topics.changed(`app:${app.id}`);
      }
    },
    /** The migrations a slot's data has had. */
    schemaVersion: (slot: string) =>
      existsSync(dataPath(slot)) ? schemaVersion(slot) : 0,
    hasData: (slot: string) => existsSync(dataPath(slot)),
    /** Copies a slot's data to a file: a consistent copy even while the slot runs. No data copies as no file. */
    copyDataTo(slot: string, file: string) {
      rmSync(file, { force: true });

      if (existsSync(dataPath(slot))) {
        database(slot).exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
      }
    },
    /** Replaces a slot's data with a file's (none: empty data). The slot must not be running. */
    replaceData(slot: string, file: string | undefined) {
      removeData(slot);

      if (file && existsSync(file)) {
        copyFileSync(file, dataPath(slot));
      }
    },
    removeData,
    route,
    fromShell,
    /** Loads every app, so a failure shows in the log at start rather than at the first call. */
    async start() {
      await Promise.all(
        [...slots.keys()].map(async (slot) => await ready(slot))
      );
    },
    /** The agent moved to another machine: drop the socket, so the next call loads every app there. */
    disconnect() {
      socket?.close();
    },
    close() {
      socket?.close();

      for (const db of databases.values()) {
        db.close();
      }
    },
  };
}

export type AppGateway = ReturnType<typeof appGateway>;

const totalChanges = (db: DatabaseSync) =>
  Number((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n);

/** "setDone" as "set done", so a search for "done" finds it. */
const spaced = (name: string) => name.replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2");

const TYPES = new Set(["string", "number", "integer", "boolean", "enum"]);

/**
 * Checks what the worker reported against sdk/app.ts, so an app that breaks a rule fails to load with every problem
 * named, and the agent that built it can fix them all at once.
 */
function checkManifest(id: string, manifest: Manifest): Loaded {
  const problems: string[] = [];

  if (
    !Array.isArray(manifest.schema) ||
    manifest.schema.some((sql) => typeof sql !== "string")
  ) {
    problems.push("schema must be a list of SQL strings");
  }

  const operations = new Map<
    string,
    { operation: Operation; args: Validator }
  >();

  for (const operation of manifest.operations) {
    const at = `operation ${operation.name}`;
    const before = problems.length;

    if (!NAME.test(operation.name)) {
      problems.push(`${at}: the name must be camelCase letters and digits`);
    }

    if (operation.kind !== "read" && operation.kind !== "write") {
      problems.push(`${at}: kind must be "read" or "write"`);
    }

    if (
      typeof operation.description !== "string" ||
      !operation.description.trim()
    ) {
      problems.push(`${at}: it needs a description`);
    }

    if (
      typeof operation.params !== "object" ||
      operation.params === null ||
      Array.isArray(operation.params)
    ) {
      problems.push(`${at}: params must be an object, {} for none`);
    } else {
      for (const [name, param] of Object.entries(operation.params)) {
        if (!NAME.test(name)) {
          problems.push(
            `${at}: param ${name}: the name must be camelCase letters and digits`
          );
        }

        if (!TYPES.has(param?.type)) {
          problems.push(
            `${at}: param ${name}: type must be one of ${[...TYPES].join(", ")}`
          );
        } else if (
          param.type === "enum" &&
          (!Array.isArray(param.values) ||
            param.values.length === 0 ||
            param.values.some((v) => typeof v !== "string"))
        ) {
          problems.push(
            `${at}: param ${name}: an enum needs values, a list of strings`
          );
        }
      }
    }

    if (problems.length === before) {
      operations.set(operation.name, {
        operation,
        args: compile(obj(parameters(operation.params))),
      });
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `The ${id} app's server.ts breaks the app rules: ${problems.join("; ")}.`
    );
  }

  return { manifest, operations };
}

function parameters(params: Record<string, Param>): Properties {
  const out: Record<string, Schema | ReturnType<typeof opt>> = {};

  for (const [name, param] of Object.entries(params)) {
    const annotations = param.description
      ? { description: param.description }
      : {};

    const schema: Schema =
      param.type === "enum"
        ? oneOf(param.values, annotations)
        : { string: str, number: num, integer: int, boolean: bool }[param.type](
            annotations
          );

    out[name] = param.optional ? opt(schema) : schema;
  }

  return out;
}

// The app gateway. Every app is a folder (folders.ts). Its server code runs in a worker on the agent's machine
// (socket.ts); its data is a SQLite database here on the host (data.ts). An app declares operations (see
// sdk/app.ts); the shell's views call them by position, and the agent finds and runs them by name through the
// catalogue's two tools (actions/), which `agent` serves. Every write tells the open views to refresh.
//
// Versions run in slots. An app's live version runs in the slot named by its id; a draft being previewed runs beside
// it in `<id>~draft`, on a copy of the live data, and the shell's views use the draft while there is one. The agent's
// actions always reach the live version unless they ask for the draft.
//
// A live app may read outside services it names (connections.ts), and keep a copy of them current with its sync
// (sync.ts), which the host also runs when a URL the sync watches changes (watch.ts). The host holds every `app.fetch`,
// and every watched URL it asks, to the app's connections and sends it with `send`, which the owner's secrets provide.
import path from "node:path";
import { bool, compile, obj, str } from "@earendil-works/pi-schema";
import type { FetchAnswer, Json } from "../../../sdk/app.ts";
import { checkFetch } from "./connections.ts";
import { openAppData } from "./data.ts";
import {
  type AppInfo,
  appTopic,
  draftSlot,
  OPERATIONS_TOPIC,
} from "./folders.ts";
import { type AppMachine, appMachine } from "./socket.ts";
import { appSync, SYNC_TOPIC } from "./sync.ts";
import { appVersions } from "./versions.ts";
import { appWatch } from "./watch.ts";
import type { Topics } from "../live/live.ts";
import type { Machine } from "../machine/machine.ts";
import {
  type Args,
  type FetchRequest,
  type Manifest,
  type Operation,
  SYNC,
} from "./protocol.ts";

// What the other parts of the host use of this context's inner files (scripts/boundaries.ts).
export {
  APP_FILES,
  APP_ID,
  appInfo,
  readAppFiles,
  readApps,
} from "./folders.ts";

export type { AppFiles, AppInfo } from "./folders.ts";

export { OPERATIONS_TOPIC } from "./folders.ts";

/** The saved apps' operations the agent may run, which the gateway offers as `agent`. */
export type AgentApps = {
  /** The user's saved apps. */
  readonly apps: () => readonly AppInfo[];
  /** A saved app's operations, once it loaded; throws why it did not. */
  readonly operations: (id: string) => Promise<readonly Operation[]>;
  /** A saved app's operations as it last loaded, without reaching the machine; undefined before it loaded. */
  readonly known: (id: string) => readonly Operation[] | undefined;
  /** Runs an operation the agent may run, in the saved app or in its draft. */
  readonly run: (action: {
    readonly app: string;
    readonly name: string;
    readonly args: Args;
    readonly draft: boolean;
  }) => Promise<Json>;
};

export { SYNC_TOPIC } from "./sync.ts";

export { hasAppData } from "./data.ts";

export { appCall, appSource, appsCalls } from "./shell.ts";

// The messages between the host, agentd and each app's worker, for host/machine/ (types only).
export type {
  Args,
  DbRequest,
  FromAgentd,
  FromWorker,
  Manifest,
  Operation,
  ReportedManifest,
  ToAgentd,
  ToWorker,
} from "./protocol.ts";

export type GatewayOptions = {
  /** The live apps to start with. */
  readonly apps: readonly AppInfo[];
  readonly dataDir: string;
  readonly topics: Topics;
  readonly machine: () => Promise<Machine>;
  /** The hosts the owner's key `secret` goes on; undefined when they have no key of that name. */
  readonly keyHosts: (secret: string) => readonly string[] | undefined;
  /** Sends an app's request, which the host checked, with the key when it names one. */
  readonly send: (request: Outbound) => Promise<FetchAnswer>;
  readonly log?: ((message: string) => void) | undefined;
};

/** An app's `app.fetch` the host checked: to `address`, the address its host resolved to, with `secret` on it. */
type Outbound = Omit<FetchRequest, "op"> & {
  readonly app: string;
  readonly secret: string | undefined;
  readonly address: string;
};

/** An operation the shell names, such as `todosSetDone(id, done)`: its arguments come in the order of its params. */
export type ShellCall = {
  readonly app: string;
  /** A live view only reads and a press only writes, so a view never runs a write on refresh. */
  readonly kind: Operation["kind"];
  readonly name: string;
  readonly args: readonly Json[];
};

type Run = {
  readonly slot: string;
  readonly name: string;
  readonly args: Args;
  /** The kind the operation must be, when the caller may run only one. */
  readonly kind?: Operation["kind"] | undefined;
  /** The agent is calling: the operation must be one the app lets it run. */
  readonly agent?: boolean | undefined;
};

type Slots = ReadonlyMap<string, AppInfo>;

export type AppGateway = ReturnType<typeof appGateway>;

export type { Which } from "./versions.ts";

const reply = compile(obj({ ok: bool() }, { open: true }));
const explained = compile(obj({ error: str() }, { open: true }));

export function appGateway(options: GatewayOptions) {
  const { topics } = options;
  const data = openAppData(path.join(options.dataDir, "apps"));

  const log =
    options.log ??
    ((message: string) => {
      console.log(message);
    });

  const machine = appMachine({
    slots: options.apps.map((app) => [app.id, app] as const),
    machine: options.machine,
    data,
    topics,
    log,
    fetch: async (slot, request) =>
      await checkedFetch(machine, options, { slot, request }),
  });

  const slots = machine.slots();

  /** The key the live version of app `id` reads with that the owner has not added, such as "github"; "" for none. */
  const needs = (id: string) =>
    machine
      .known(id)
      ?.manifest.connections.find(
        ({ secret }) =>
          secret !== undefined && options.keyHosts(secret) === undefined
      )?.secret ?? "";

  const sync = appSync({
    dataDir: path.join(options.dataDir, "apps"),
    slots: () => slots,
    known: machine.known,
    awake: machine.awake,
    waiting: (id) => needs(id) !== "",
    run: async (id) => {
      await machine.call(id, SYNC, {});
    },
    changed: () => {
      topics.changed(SYNC_TOPIC);
    },
  });

  const watch = appWatch({
    dataDir: path.join(options.dataDir, "apps"),
    slots: () => slots,
    known: machine.known,
    ask: async (slot, request) =>
      await checkedFetch(machine, options, { slot, request }),
    changed: sync.now,
    log,
  });

  const agent = agentApps(machine);

  /** Stops whatever runs in `slot`. Its data stays. */
  const uninstall = (slot: string) => {
    const app = machine.uninstall(slot);

    data.close(slot);

    if (app) {
      topics.changed(appTopic(app.id));
      topics.changed(OPERATIONS_TOPIC);
    }
  };

  const versions = appVersions({
    machine,
    data,
    scratchDir: path.join(options.dataDir, "apps"),
    install: async (slot, app) => (await machine.install(slot, app)).manifest,
    uninstall,
  });

  return {
    /**
     * The saved apps' operations the agent may run, and their runs: what the imp's catalogue (actions/) and other
     * assistants (over MCP) reach, by the same path, so a write refreshes the open views either way.
     */
    agent,
    /** Every app the shell or the agent can reach, saved or only a draft so far: the draft's name when it has one. */
    apps: () => shown(slots),
    /** Each app's live version and draft, which only the studio moves (versions.ts). */
    ...versions,
    /** The app and the operation name of a shell source such as `todosSetDone`, if an app owns it. */
    route: (source: string) => route(slots, source),
    fromShell: async (call: ShellCall) => {
      // An open tab reads its app: the live version syncs if it is due.
      if (call.kind === "read" && !slots.has(draftSlot(call.app))) {
        sync.opened(call.app);
      }

      return await fromShell(machine, call);
    },
    /** Sync now: runs the live version's sync, and answers why it failed, if it did. */
    syncNow: async (id: string) => await sync.now(id),
    /** What the app's bar says about its live version's sync: "Synced 3 min ago"; "" for an app without one. */
    syncLine: sync.line,
    needs,
    /** The owner added or removed a key: what waited for one syncs now. */
    keysChanged: sync.resume,
    /** What the version the shell shows reads, in words: "Reads api.github.com with your github key, every 15 min." */
    reads: (id: string) => {
      const slot = slots.has(draftSlot(id)) ? draftSlot(id) : id;
      const manifest = machine.known(slot)?.manifest;

      return manifest ? readsLine(manifest) : "";
    },
    /** Loads every app, so a failure shows in the log at start rather than at the first call. */
    async start() {
      await Promise.all(
        [...slots.keys()].map(async (slot) => await machine.loaded(slot))
      );
    },
    /** The agent moved to another machine: drop the socket, so the next call loads every app there. */
    disconnect() {
      machine.disconnect();
    },
    close() {
      watch.stop();
      sync.stop();
      machine.disconnect();
      data.closeAll();
    },
  };
}

/** The saved apps' operations, as the imp's catalogue finds and runs them, and other assistants over MCP. */
const agentApps = (machine: AppMachine): AgentApps => ({
  apps: () => saved(machine.slots()),
  operations: async (id) => (await machine.loaded(id)).manifest.operations,
  known: (id) => machine.known(id)?.manifest.operations,
  run: async ({ app, name, args, draft }) =>
    await run(machine, {
      slot: draft ? draftSlot(app) : app,
      name,
      args,
      agent: true,
    }),
});

/** Holds the `app.fetch` of the version in `slot` to its connections, then sends it. */
async function checkedFetch(
  machine: AppMachine,
  options: GatewayOptions,
  { slot, request }: { slot: string; request: FetchRequest }
) {
  const app = machine.slots().get(slot)?.id ?? slot;

  const { url, secret, address } = await checkFetch(
    {
      app,
      connections: machine.known(slot)?.manifest.connections ?? [],
      keyHosts: options.keyHosts,
    },
    request
  );

  const { method, headers, body } = request;

  return await options.send({
    app,
    url: url.href,
    method: method.toUpperCase(),
    headers,
    body,
    secret,
    address,
  });
}

const EVERY_WORDS = {
  "15m": "every 15 min",
  "1h": "every hour",
  "6h": "every 6 hours",
  "1d": "once a day",
} as const;

/** What a version reads, in words; "" when it reads nothing. */
function readsLine({ connections, every, watch }: Manifest) {
  if (connections.length === 0) {
    return "";
  }

  const hosts = connections.map(({ host, secret }) =>
    secret ? `${host} with your ${secret} key` : host
  );

  const watched = watch.map((url) => url.replace(/^https:\/\//, ""));

  return `Reads ${hosts.join(", ")}${every ? `, ${EVERY_WORDS[every]}` : ""}${watched.length > 0 ? `, and when ${watched.join(" or ")} changes` : ""}.`;
}

/** The saved apps: the ones in the slot named by their id. */
const saved = (slots: Slots) =>
  [...slots].flatMap(([slot, app]) => (slot === app.id ? [app] : []));

function shown(slots: Slots) {
  const apps = new Map<string, AppInfo>();

  for (const [slot, app] of slots) {
    const draft = slot === draftSlot(app.id);

    if (draft || (slot === app.id && !apps.has(app.id))) {
      apps.set(app.id, app);
    }
  }

  return [...apps.values()].map(({ id, name, description, symbol, cover }) => ({
    id,
    name,
    description,
    symbol,
    cover,
  }));
}

function route(slots: Slots, source: string) {
  const owner = [...slots.values()].find(
    ({ id }) =>
      source.startsWith(id) &&
      /^[A-Z]/.test(source.slice(id.length)) &&
      // A version only being checked is the host's own: the shell reaches saved apps and drafts.
      (slots.has(id) || slots.has(draftSlot(id)))
  );

  const rest = source.slice(owner?.id.length);

  return owner
    ? { app: owner.id, name: rest.charAt(0).toLowerCase() + rest.slice(1) }
    : undefined;
}

/** Runs an operation in a slot with named arguments, checked against its params. */
async function run(machine: AppMachine, call: Run) {
  const { slot, name, args, kind, agent } = call;
  const id = machine.slots().get(slot)?.id;

  if (!id) {
    throw new Error(`There is no ${slot.replace("~draft", " draft")} app.`);
  }

  const entry = (await machine.loaded(slot)).operations.get(name);

  if (!entry) {
    throw new Error(`The ${id} app has no operation named ${name}.`);
  }

  if (kind && entry.operation.kind !== kind) {
    throw new Error(
      `The ${id} app's ${name} is a ${entry.operation.kind}, not a ${kind}.`
    );
  }

  if (agent && !entry.operation.agent) {
    throw new Error(`The ${id} app keeps ${name} from the agent.`);
  }

  const errors = entry.args.errors(args);

  if (errors.length > 0) {
    const why = errors
      .map((error) => `${error.path || "args"}: ${error.message}`)
      .join("; ");

    throw new Error(
      `The ${id} app's ${name} was called with arguments it does not take: ${why}.`
    );
  }

  return await machine.call(slot, name, args);
}

/**
 * Runs an operation the shell names, in the version the shell shows: the draft while there is one. A write answers
 * the shell's Reply, `{ ok, error }`, whatever the operation returns, unless it returns one itself.
 */
async function fromShell(machine: AppMachine, call: ShellCall) {
  const { app: id, kind, name, args } = call;
  const slots = machine.slots();
  const slot = slots.has(draftSlot(id)) ? draftSlot(id) : id;

  if (!slots.has(slot)) {
    throw new Error(`There is no ${id} app.`);
  }

  const operation = (await machine.loaded(slot)).operations.get(name);
  const params = Object.keys(operation?.operation.params ?? {});

  if (operation && args.length > params.length) {
    throw new Error(
      `The ${id} app's ${name} takes ${params.length} argument${params.length === 1 ? "" : "s"}, not ${args.length}.`
    );
  }

  const named = Object.fromEntries(
    params.slice(0, args.length).map((param, i) => [param, args[i] ?? null])
  );

  const value = await run(machine, { slot, name, args: named, kind });

  if (kind === "read") {
    return value;
  }

  if (!reply.check(value)) {
    return { ok: true, error: "" };
  }

  return { ok: value.ok, error: explained.check(value) ? value.error : "" };
}

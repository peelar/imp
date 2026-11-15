// The app gateway. Every app is a folder (folders.ts). Its server code runs in a worker on the agent's machine
// (socket.ts); its data is a SQLite database here on the host (data.ts). An app declares operations (see
// sdk/app.ts); the shell's views call them by position, and the agent finds and runs them by name through two tools
// (tools.ts). Every write tells the open views to refresh.
//
// Versions run in slots. An app's live version runs in the slot named by its id; a draft being previewed runs beside
// it in `<id>~draft`, on a copy of the live data, and the shell's views use the draft while there is one. The agent's
// actions always reach the live version unless they ask for the draft.
import path from "node:path";
import type { Registry } from "@earendil-works/pi-durable";
import { bool, compile, obj, str } from "@earendil-works/pi-schema";
import type { Json } from "../../../sdk/app.ts";
import { openAppData } from "./data.ts";
import { type AppInfo, appTopic, draftSlot } from "./folders.ts";
import { type AppMachine, appMachine } from "./socket.ts";
import { appTools } from "./tools.ts";
import { appVersions } from "./versions.ts";
import type { Topics } from "../kernel/live.ts";
import type { Machine } from "../machine/machine.ts";
import type { Args, Operation } from "./protocol.ts";

// What the other parts of the host use of this context's inner files (scripts/boundaries.ts).
export {
  APP_FILES,
  APP_ID,
  appInfo,
  appTopic,
  readAppFiles,
  readApps,
} from "./folders.ts";

export type { AppFiles, AppInfo } from "./folders.ts";

export type { Manifest, Operation } from "./protocol.ts";

export type GatewayOptions = {
  /** The live apps to start with. */
  readonly apps: readonly AppInfo[];
  readonly dataDir: string;
  readonly topics: Topics;
  readonly registry: Registry;
  readonly machine: () => Promise<Machine>;
  readonly log?: ((message: string) => void) | undefined;
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

  const machine = appMachine({
    slots: options.apps.map((app) => [app.id, app] as const),
    machine: options.machine,
    data,
    topics,
    log:
      options.log ??
      ((message) => {
        console.log(message);
      }),
  });

  const slots = machine.slots();

  options.registry.install(
    appTools({
      apps: () => saved(slots),
      operations: async (id) => (await machine.loaded(id)).manifest.operations,
      run: async ({ app, name, args, draft }) =>
        await run(machine, {
          slot: draft ? draftSlot(app) : app,
          name,
          args,
          agent: true,
        }),
    })
  );

  /** Stops whatever runs in `slot`. Its data stays. */
  const uninstall = (slot: string) => {
    const app = machine.uninstall(slot);

    data.close(slot);

    if (app) {
      topics.changed(appTopic(app.id));
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
    /** Every app the shell or the agent can reach, saved or only a draft so far: the draft's name when it has one. */
    apps: () => shown(slots),
    /** Each app's live version and draft, which only the studio moves (versions.ts). */
    ...versions,
    /** The app and the operation name of a shell source such as `todosSetDone`, if an app owns it. */
    route: (source: string) => route(slots, source),
    fromShell: async (call: ShellCall) => await fromShell(machine, call),
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
      machine.disconnect();
      data.closeAll();
    },
  };
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

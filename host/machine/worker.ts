// One app's server code, in a worker of its own. The module's default export is the app (see sdk/app.ts); its
// database and its owner's keys are on the host, so every `app.db` and `app.fetch` call goes to the host and back.
//
// The host strips this file's types and installs it on the machine as worker.mjs (src/computer/runtime.ts), where it
// runs with no packages: import only types and Node's own modules.
import { parentPort, workerData } from "node:worker_threads";
import type {
  AppContext,
  FetchAnswer,
  FetchInit,
  Json,
  SqlValue,
} from "../../sdk/app.ts";
import type {
  Args,
  DbRequest,
  FromWorker,
  ReportedManifest,
  ToWorker,
} from "../src/apps/apps.ts";

type Start = { readonly appId: string; readonly code: string };

type Call = Extract<ToWorker, { t: "call" }>;

/** An operation's `run`. The agent wrote it, so it may answer nothing at all. */
type Run = (
  args: Args,
  app: AppContext
) => Json | undefined | Promise<Json | undefined>;

/**
 * What the agent's module exports, which is a claim until checked. This worker checks only that every operation has
 * a `run` function, which it alone can see; the host checks the rest from the manifest (src/apps/manifest.ts).
 */
type Claimed = {
  readonly schema?: ReportedManifest["schema"];
  readonly operations?: Readonly<Record<string, ClaimedOperation | null>>;
  readonly connections?: ReportedManifest["connections"];
  readonly sync?: {
    readonly every?: ReportedManifest["every"];
    readonly watch?: ReportedManifest["watch"];
    readonly run?: SyncRun | null;
  } | null;
};

/** A sync's `run`. The agent wrote it, so it may answer anything; the host keeps none of it. */
type SyncRun = (app: AppContext) => void | Promise<void>;

const isSyncRun = (run: SyncRun | null | undefined): run is SyncRun =>
  typeof run === "function";

/** The call that runs the app's sync (src/apps/protocol.ts, SYNC): no operation has this name. */
const SYNC = "@sync";

type ClaimedOperation = {
  readonly kind?: ReportedManifest["operations"][number]["kind"];
  readonly description?: ReportedManifest["operations"][number]["description"];
  readonly params?: ReportedManifest["operations"][number]["params"];
  readonly agent?: boolean;
  readonly run?: Run | null;
};

if (!parentPort) {
  throw new Error("worker.mjs runs as a worker of agentd");
}

const port = parentPort;

// SAFETY: agentd starts every worker with `workerData: { appId, code }` (machine/agentd.ts, `load`).
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- workerData is typed `any`.
const { appId, code } = workerData as Start;
let nextId = 1;

const waiting = new Map<
  number,
  { resolve: (value: Json) => void; reject: (error: Error) => void }
>();

const post = (message: FromWorker) => {
  port.postMessage(message);
};

const db = async (request: DbRequest) => {
  const id = nextId;

  nextId += 1;

  return await new Promise<Json>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    post({ t: "db", id, request });
  });
};

// SAFETY: the host answers each request with what its SQLite returned for it (src/apps/data.ts): rows for `all`, a
// row or null for `get`, the change counts for `run` and `batch`; and a fetch with its answer (src/secrets/app-fetch.ts).
// The types are the ones sdk/app.ts promises the app.
/* oxlint-disable typescript/no-unsafe-type-assertion -- a database answer crosses the wire as JSON */
const app: AppContext = Object.freeze({
  id: appId,
  fetch: async (url: string, init: FetchInit = {}) =>
    (await db({
      op: "fetch",
      url,
      method: init.method ?? "GET",
      headers: { ...init.headers },
      body: init.body ?? "",
    })) as FetchAnswer,
  db: Object.freeze({
    all: async <T>(sql: string, ...params: SqlValue[]) =>
      (await db({ op: "all", sql, params })) as T[],
    get: async <T>(sql: string, ...params: SqlValue[]) =>
      (await db({ op: "get", sql, params })) as T | null,
    run: async (sql: string, ...params: SqlValue[]) =>
      (await db({ op: "run", sql, params })) as {
        changes: number;
        lastInsertRowid: number;
      },
    /** Runs the statements in one transaction: all of them or none. */
    batch: async (
      statements: readonly { sql: string; params?: SqlValue[] }[]
    ) =>
      (await db({ op: "batch", statements: [...statements] })) as {
        changes: number;
        lastInsertRowid: number;
      }[],
  }),
});
/* oxlint-enable typescript/no-unsafe-type-assertion */

const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

const runOf = (operation: ClaimedOperation | null): Run | undefined =>
  isRun(operation?.run) ? operation.run : undefined;

const isRun = (run: ClaimedOperation["run"]): run is Run =>
  typeof run === "function";

/** The app's operations by name, and what the host needs to know about them. */
async function load() {
  // SAFETY: the agent wrote this module, so nothing about its shape is certain; `Claimed` says only what this file
  // reads from it, and every field is optional.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- import() is typed `any`.
  const module = (await import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  )) as { default?: Claimed };

  const definition = module.default ?? {};
  const runs = new Map<string, Run>();
  const operations: ReportedManifest["operations"] = [];

  for (const [name, operation] of Object.entries(definition.operations ?? {})) {
    const run = runOf(operation);

    if (!run) {
      throw new TypeError(`the operation ${name} has no run function`);
    }

    runs.set(name, run);
    // The host checks the rest of the manifest: it holds the rules for names, kinds and params.
    operations.push({
      name,
      kind: operation?.kind,
      description: operation?.description,
      params: operation?.params,
      agent: operation?.agent !== false,
    });
  }

  const { sync } = definition;

  if (sync) {
    const { run } = sync;

    if (!isSyncRun(run)) {
      throw new TypeError("sync has no run function");
    }

    // The sync takes the app and nothing else, and answers nothing.
    runs.set(SYNC, async (_args, context) => {
      await run(context);

      return null;
    });
  }

  const manifest: ReportedManifest = {
    schema: definition.schema ?? [],
    operations,
    connections: definition.connections,
    every: sync ? (sync.every ?? null) : undefined,
    watch: sync?.watch,
  };

  return { manifest, runs };
}

async function answer(call: Call, runs: ReadonlyMap<string, Run>) {
  try {
    const run = runs.get(call.name);

    if (!run) {
      throw new Error(`${appId} has no operation named ${call.name}`);
    }

    const value = await run(call.args, app);

    post({ t: "result", id: call.id, ok: true, value: value ?? null });
  } catch (error) {
    post({ t: "result", id: call.id, ok: false, error: errorText(error) });
  }
}

function settle(message: Extract<ToWorker, { t: "dbResult" }>) {
  const request = waiting.get(message.id);

  waiting.delete(message.id);

  if (message.ok) {
    request?.resolve(message.value);
  } else {
    request?.reject(new Error(message.error));
  }
}

try {
  const { manifest, runs } = await load();

  // Only agentd posts to a worker, and it posts ToWorker.
  port.on("message", (message: ToWorker) => {
    if (message.t === "dbResult") {
      settle(message);
    } else {
      // oxlint-disable-next-line typescript/no-floating-promises -- `answer` reports every failure as the call's result, so it never rejects.
      answer(message, runs);
    }
  });
  post({ t: "ready", manifest });
} catch (error) {
  post({
    t: "failed",
    error:
      error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
}

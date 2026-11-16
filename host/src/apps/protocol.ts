// The messages between the host, agentd and each app's worker (machine/agentd.ts and machine/worker.ts). The egress
// proxy's messages are the secrets' own (secrets/egress-protocol.ts).
//
//   host   -> agentd   ToAgentd     load and unload apps, call their operations, answer their requests
//   agentd -> host     FromAgentd   what loaded, call results, the apps' requests
//   agentd -> worker   ToWorker     calls and answers to its requests
//   worker -> agentd   FromWorker   the app's manifest, call results, requests
//
// An app's requests go to the host because what they reach is the host's: its database (`app.db`), and its owner's
// keys (`app.fetch`). They travel as `db` messages, and `op` says which.
//
// The machine runs code the agent wrote, so the host checks everything it receives against the schemas below. The
// machine files import this module's types only, through apps.ts: they are stripped to plain JavaScript and run with
// no packages.
import {
  arr,
  bool,
  compile,
  int,
  lit,
  map,
  nul,
  num,
  obj,
  oneOf,
  opt,
  recursive,
  type Static,
  str,
  union,
  unknown,
} from "@earendil-works/pi-schema";
import type { Connection, Json, Param, SyncEvery } from "../../../sdk/app.ts";

const json = recursive<Json>("json", (self) =>
  union([nul(), bool(), num(), str(), arr(self), map(self)])
);

const sqlValue = union([nul(), num(), str()]);

/**
 * An app's manifest as its worker reports it. The worker builds this frame, so the frame is certain; what it carries
 * (`schema`, and each operation's `kind`, `description` and `params`) is whatever the app's module exported, and
 * `checkManifest` (manifest.ts) decides whether the app loaded.
 */
const reportedManifest = obj({
  schema: opt(unknown()),
  operations: arr(
    obj({
      name: str(),
      kind: opt(unknown()),
      description: opt(unknown()),
      params: opt(unknown()),
      agent: bool(),
    })
  ),
  connections: opt(unknown()),
  /** The app's `sync.every`; absent when it has no sync. */
  every: opt(unknown()),
  /** The app's `sync.watch`. */
  watch: opt(unknown()),
});

const dbRequest = union([
  obj({
    op: oneOf(["all", "get", "run"]),
    sql: str(),
    params: arr(sqlValue),
  }),
  obj({
    op: lit("batch"),
    statements: arr(obj({ sql: str(), params: opt(arr(sqlValue)) })),
  }),
  obj({
    op: lit("fetch"),
    url: str(),
    method: str(),
    headers: map(str()),
    body: str(),
  }),
]);

const callResult = union([
  obj({ t: lit("result"), id: str(), ok: lit(true), value: json }),
  obj({ t: lit("result"), id: str(), ok: lit(false), error: str() }),
]);

const fromAgentd = union([
  obj({
    t: lit("loaded"),
    app: str(),
    hash: str(),
    manifest: reportedManifest,
  }),
  obj({ t: lit("loadFailed"), app: str(), hash: str(), error: str() }),
  callResult,
  obj({ t: lit("db"), id: int(), app: str(), request: dbRequest }),
]);

export type ReportedManifest = Static<typeof reportedManifest>;

export type ReportedOperation = ReportedManifest["operations"][number];

export type DbRequest = Static<typeof dbRequest>;

/** An app's `app.fetch`, as the worker sends it to the host. */
export type FetchRequest = Extract<DbRequest, { op: "fetch" }>;

/** An app's `app.db` call. */
export type SqlRequest = Exclude<DbRequest, FetchRequest>;

type CallResult = Static<typeof callResult>;

export type FromAgentd = Static<typeof fromAgentd>;

/** An operation the host accepted: every field is what sdk/app.ts says it is. */
export type Operation = {
  readonly name: string;
  readonly kind: "read" | "write";
  readonly description: string;
  readonly params: Readonly<Record<string, Param>>;
  /** Whether the agent may find and run it. */
  readonly agent: boolean;
};

export type Manifest = {
  /** The app's migrations, in order. */
  readonly schema: readonly string[];
  readonly operations: readonly Operation[];
  readonly connections: readonly Connection[];
  /** How often the app syncs; absent when it has no sync. */
  readonly every?: SyncEvery | undefined;
  /** The URLs whose change starts the sync (connections.ts, checkWatch). */
  readonly watch: readonly string[];
};

/** What a call runs when its name is this: the app's sync, which no operation can be named (they are camelCase). */
export const SYNC = "@sync";

/** An operation's arguments by param name. */
export type Args = { [name: string]: Json };

export type DbResult =
  | { t: "dbResult"; id: number; ok: true; value: Json }
  | { t: "dbResult"; id: number; ok: false; error: string };

export type ToAgentd =
  | { t: "load"; app: string; hash: string; code: string }
  | { t: "unload"; app: string }
  | { t: "call"; id: string; app: string; name: string; args: Args }
  | DbResult;

export type ToWorker =
  | { t: "call"; id: string; name: string; args: Args }
  | DbResult;

export type FromWorker =
  | { t: "ready"; manifest: ReportedManifest }
  | { t: "failed"; error: string }
  | CallResult
  | { t: "db"; id: number; request: DbRequest };

export const fromAgentdCheck = compile(fromAgentd);

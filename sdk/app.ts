// What an app's server.ts exports, as `export default { ... } satisfies AppServer`. The code runs in a worker of its
// own on the agent's machine, with no packages to import; the database it uses lives on the host.
//
// An app declares each thing it can do once, as an operation, and both its screen and the agent use it:
//
// - The shell's Contract calls an operation `<appId><Name>`, with its arguments in the order of `params`: the todos
//   app's `setDone` is `todosSetDone(id, done)`. A read streams live to the screen and answers again after every write.
// - The agent finds operations with `find_app_actions` and runs them with `run_app_action`, by name and with named
//   arguments. Every operation is the agent's unless it says `agent: false`.

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export type SqlValue = null | number | string;

/** What `app.fetch` sends: a method other than GET, headers and a text body are optional. */
export type FetchInit = {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
};

/** What `app.fetch` answers: the status, the headers by lowercase name, and the body as text. */
export type FetchAnswer = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

export type AppContext = {
  readonly id: string;
  /**
   * Reads from a service the app names in `connections`, such as `app.fetch("https://api.github.com/notifications")`.
   * The host sends it, with the owner's key when the connection names one; the key never reaches the app. Only reads:
   * GET and HEAD, and POST to a connection's `query` path. It throws when the request breaks a rule, or when the
   * connection's key is missing ("needs secret github"). Redirects are not followed.
   */
  readonly fetch: (url: string, init?: FetchInit) => Promise<FetchAnswer>;
  readonly db: {
    readonly all: <T = Record<string, SqlValue>>(
      sql: string,
      ...params: SqlValue[]
    ) => Promise<T[]>;
    readonly get: <T = Record<string, SqlValue>>(
      sql: string,
      ...params: SqlValue[]
    ) => Promise<T | null>;
    readonly run: (
      sql: string,
      ...params: SqlValue[]
    ) => Promise<{ changes: number; lastInsertRowid: number }>;
    /** Runs the statements in one transaction: all of them or none. */
    readonly batch: (
      statements: readonly { sql: string; params?: SqlValue[] }[]
    ) => Promise<{ changes: number; lastInsertRowid: number }[]>;
  };
};

export type Param =
  | {
      type: "string" | "number" | "integer" | "boolean";
      description?: string;
      optional?: boolean;
    }
  | {
      type: "enum";
      values: readonly string[];
      description?: string;
      optional?: boolean;
    };

export type AppOperation = {
  /** A read answers without changing anything; a write changes the app's data. */
  readonly kind: "read" | "write";
  /** What the operation does, for the agent: it searches these. */
  readonly description: string;
  /** The arguments, in the order the screen passes them. The host checks every call against them. */
  readonly params: Readonly<Record<string, Param>>;
  /** `false` keeps the operation from the agent; the screen can still call it. */
  readonly agent?: false;
  /**
   * A method on purpose: an app may say more about its arguments than this type does, such as
   * `run({ title }: { title: string })`, because the host checks every call against `params` first.
   */
  // oxlint-disable-next-line typescript/method-signature-style -- a property signature would refuse an app's narrower argument types, which `params` makes true.
  run(args: Record<string, Json>, app: AppContext): Json | Promise<Json>;
};

/** A service the app reads with `app.fetch`. */
export type Connection = {
  /** The host name, such as "api.github.com". The app reaches it over HTTPS on port 443 only. */
  readonly host: string;
  /** The name of the owner's key that goes on its requests, such as "github"; none for a public service. */
  readonly secret?: string;
  /** A path that takes reads by POST, such as "/graphql": the one place the app may POST to. */
  readonly query?: string;
};

/** How often the host syncs an app, at most. */
export type SyncEvery = "15m" | "1h" | "6h" | "1d";

export type AppServer = {
  /** Migrations, in order. The host applies the ones a database has not had yet, before the first call. */
  readonly schema?: readonly string[];
  /** Everything the app does, by camelCase name, such as `setDone`. */
  readonly operations?: Readonly<Record<string, AppOperation>>;
  /** The services the app reads: the owner sees them before Save, and the host refuses `app.fetch` to any other. */
  readonly connections?: readonly Connection[];
  /**
   * Brings outside data into `app.db`, so the operations answer from the last good copy. The host runs it on the live
   * version, never a draft: when its tab opens and the data is older than `every`, on Sync now, on schedule while the
   * computer is awake (a schedule never wakes it), and when a `watch` URL changed (which does). Fetch everything first, then write it in one `app.db.batch`,
   * so a failure halfway keeps the last copy whole.
   */
  readonly sync?: {
    readonly every: SyncEvery;
    /**
     * URLs that say when the service has something new, such as "https://api.github.com/notifications": the host asks
     * them itself, as often as the service allows (at least a minute apart), with the ETag or Last-Modified it saw
     * last, so an answer of "nothing new" (304) costs neither the service's rate limit nor the computer. When one
     * changes, the host runs the sync, waking the computer if it must. Each is a GET to one of the app's connections.
     */
    readonly watch?: readonly string[];
    readonly run: (app: AppContext) => void | Promise<void>;
  };
};

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

export type AppContext = {
  readonly id: string;
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

export type AppServer = {
  /** Migrations, in order. The host applies the ones a database has not had yet, before the first call. */
  readonly schema?: readonly string[];
  /** Everything the app does, by camelCase name, such as `setDone`. */
  readonly operations?: Readonly<Record<string, AppOperation>>;
};

// What an app's server.ts exports, as `export default { ... } satisfies AppServer`. The code runs in a worker of its
// own on the agent's machine, with no packages to import; the database it uses lives on the host.
//
// Names: the shell's Contract calls a source or mutation `<appId><Name>` (the todos app's `list` is `todosList()`),
// and the agent sees each tool under its own name, which starts with `<appId>_`.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type SqlValue = null | number | string;

export interface AppContext {
	readonly id: string;
	readonly db: {
		all<T = Record<string, SqlValue>>(sql: string, ...params: SqlValue[]): Promise<T[]>;
		get<T = Record<string, SqlValue>>(sql: string, ...params: SqlValue[]): Promise<T | null>;
		run(sql: string, ...params: SqlValue[]): Promise<{ changes: number; lastInsertRowid: number }>;
		/** Runs the statements in one transaction: all of them or none. */
		batch(statements: readonly { sql: string; params?: SqlValue[] }[]): Promise<{ changes: number; lastInsertRowid: number }[]>;
	};
}

export type Param =
	| { type: "string" | "number" | "integer" | "boolean"; description?: string; optional?: boolean }
	| { type: "enum"; values: readonly string[]; description?: string; optional?: boolean };

export interface AppTool {
	readonly description: string;
	readonly params: Readonly<Record<string, Param>>;
	run(args: Record<string, Json>, app: AppContext): Json | Promise<Json>;
}

export interface AppServer {
	/** Migrations, in order. The host applies the ones a database has not had yet, before the first call. */
	readonly schema?: readonly string[];
	/** What the app's views read. The shell streams each one live, and pushes a new answer after every write. */
	readonly sources?: Readonly<Record<string, (args: Json[], app: AppContext) => Json | Promise<Json>>>;
	/** What the app's views change. Each answers a `Reply`: `{ ok, error }`. */
	readonly mutations?: Readonly<Record<string, (args: Json[], app: AppContext) => Json | Promise<Json>>>;
	/** What the agent calls to operate the app. */
	readonly tools?: Readonly<Record<string, AppTool>>;
}

// The app gateway. Every app is a folder (app.json, app.contract, server.ts). Its server code runs in a worker on the
// agent's machine, reached over one WebSocket the host opens to agentd; its data is a SQLite database here on the
// host, which the worker reads and writes through that socket. The shell's views and the agent's tools both call the
// app through this gateway, and every write tells the open views to refresh.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { defineExtension, defineTool, type Registry, section } from "@earendil-works/pi-durable";
import { bool, int, num, obj, oneOf, opt, type Properties, type Schema, str } from "@earendil-works/pi-schema";
import WebSocket from "ws";
import type { Topics } from "./live.ts";
import type { Machine } from "./machine.ts";

/** Names the shell's own sources use, so no app may take them as its id. */
const RESERVED = new Set(["chat", "account", "shell", "apps", "machine"]);
const CALL_TIMEOUT_MS = 60_000;

interface AppInfo {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	/** The app's icon in the shell, a `symbol:` source. */
	readonly symbol: string;
	/** The app's engraved cover in the shell, a client asset path such as "assets/art/todos.jpg"; "" for none. */
	readonly cover: string;
	readonly code: string;
	readonly hash: string;
}

type Param =
	| { type: "string" | "number" | "integer" | "boolean"; description?: string; optional?: boolean }
	| { type: "enum"; values: string[]; description?: string; optional?: boolean };

interface Manifest {
	schema: string[];
	sources: string[];
	mutations: string[];
	tools: { name: string; description: string; params: Record<string, Param> }[];
}

type Kind = "source" | "mutation" | "tool";
type FromMachine =
	| { t: "loaded"; app: string; hash: string; manifest: Manifest }
	| { t: "loadFailed"; app: string; hash: string; error: string }
	| { t: "result"; id: string; ok: boolean; value?: unknown; error?: string }
	| {
			t: "db";
			id: number;
			app: string;
			op: "all" | "get" | "run" | "batch";
			sql?: string;
			params?: SQLInputValue[];
			statements?: { sql: string; params?: SQLInputValue[] }[];
	  };

/** Reads every app folder under `dir`. */
export function readApps(dir: string): AppInfo[] {
	if (!existsSync(dir)) return [];
	const apps: AppInfo[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const folder = join(dir, entry.name);
		const meta = JSON.parse(readFileSync(join(folder, "app.json"), "utf8")) as {
			id?: string;
			name?: string;
			description?: string;
			symbol?: string;
			cover?: string;
		};
		if (meta.id !== entry.name || !/^[a-z][a-z0-9]*$/.test(meta.id) || RESERVED.has(meta.id)) {
			throw new Error(`apps/${entry.name}: app.json's id must be the folder's name, lowercase letters and digits, and not ${[...RESERVED].join(", ")}`);
		}
		const code = stripTypeScriptTypes(readFileSync(join(folder, "server.ts"), "utf8"), { mode: "strip" });
		apps.push({
			id: meta.id,
			name: meta.name ?? meta.id,
			description: meta.description ?? "",
			symbol: meta.symbol?.startsWith("symbol:") ? meta.symbol : "symbol:layers",
			cover: meta.cover && /^assets\/[\w/.-]+$/.test(meta.cover) ? meta.cover : "",
			code,
			hash: createHash("sha256").update(code).digest("hex").slice(0, 16),
		});
	}
	return apps;
}

export interface GatewayOptions {
	readonly apps: readonly AppInfo[];
	readonly dataDir: string;
	readonly topics: Topics;
	readonly registry: Registry;
	readonly machine: () => Promise<Machine>;
	readonly log?: (message: string) => void;
}

export function appGateway(options: GatewayOptions) {
	const log = options.log ?? ((message) => console.log(message));
	const apps = new Map(options.apps.map((app) => [app.id, app]));
	mkdirSync(join(options.dataDir, "apps"), { recursive: true });
	const databases = new Map<string, DatabaseSync>();
	const database = (id: string) => {
		let db = databases.get(id);
		if (!db) databases.set(id, (db = new DatabaseSync(join(options.dataDir, "apps", `${id}.sqlite`))));
		return db;
	};

	let socket: WebSocket | undefined;
	let connecting: Promise<WebSocket> | undefined;
	/** Per app: the manifest of the version loaded on the machine, or the wait for it. */
	const loaded = new Map<string, Manifest>();
	/** Per app: why its current version failed to load on this connection. */
	const failures = new Map<string, Error>();
	const loadWaiters = new Map<string, { resolve: (m: Manifest) => void; reject: (e: Error) => void }[]>();
	const calls = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

	function connect(): Promise<WebSocket> {
		if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket);
		return (connecting ??= (async () => {
			const endpoint = await (await options.machine()).appSocket();
			const ws = new WebSocket(endpoint.url, { headers: { ...endpoint.headers }, maxPayload: 64 * 1024 * 1024 });
			await new Promise<void>((resolve, reject) => {
				ws.once("open", resolve);
				ws.once("error", reject);
			});
			ws.on("message", (data) => onMessage(ws, JSON.parse(String(data)) as FromMachine));
			ws.on("close", () => onClose(ws));
			ws.on("error", (error) => log(`app socket: ${error.message}`));
			socket = ws;
			// Nothing on the machine has to survive: load every app on every connection. agentd skips an unchanged one.
			for (const app of apps.values()) ws.send(JSON.stringify({ t: "load", app: app.id, hash: app.hash, code: app.code }));
			return ws;
		})().finally(() => {
			connecting = undefined;
		}));
	}

	function onClose(ws: WebSocket) {
		if (socket !== ws) return;
		socket = undefined;
		loaded.clear();
		failures.clear();
		const lost = new Error("The connection to the agent's machine was lost; try again.");
		for (const [id, call] of calls) {
			clearTimeout(call.timer);
			call.reject(lost);
			calls.delete(id);
		}
		for (const [id, waiters] of loadWaiters) {
			for (const waiter of waiters) waiter.reject(lost);
			loadWaiters.delete(id);
		}
	}

	function onMessage(ws: WebSocket, message: FromMachine) {
		if (message.t === "loaded") {
			const app = apps.get(message.app);
			if (!app || app.hash !== message.hash) return;
			try {
				migrate(app.id, message.manifest.schema);
				installTools(app, message.manifest);
			} catch (error) {
				return settleLoad(app.id, error instanceof Error ? error : new Error(String(error)));
			}
			loaded.set(app.id, message.manifest);
			settleLoad(app.id, message.manifest);
			// A new version may answer differently: refresh the app's open views.
			options.topics.changed(`app:${app.id}`);
		} else if (message.t === "loadFailed") {
			log(`app ${message.app} failed to load: ${message.error}`);
			settleLoad(message.app, new Error(`The ${message.app} app failed to start: ${message.error.split("\n")[0]}`));
		} else if (message.t === "result") {
			const call = calls.get(message.id);
			if (!call) return;
			calls.delete(message.id);
			clearTimeout(call.timer);
			if (message.ok) call.resolve(message.value ?? null);
			else call.reject(new Error(message.error ?? "The app failed."));
		} else if (message.t === "db") {
			let reply: object;
			try {
				reply = { t: "dbResult", id: message.id, ok: true, value: runDb(message.app, message) };
			} catch (error) {
				reply = { t: "dbResult", id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) };
			}
			ws.send(JSON.stringify(reply));
		}
	}

	function settleLoad(id: string, result: Manifest | Error) {
		if (result instanceof Error) failures.set(id, result);
		else failures.delete(id);
		for (const waiter of loadWaiters.get(id) ?? []) {
			if (result instanceof Error) waiter.reject(result);
			else waiter.resolve(result);
		}
		loadWaiters.delete(id);
	}

	function runDb(id: string, message: Extract<FromMachine, { t: "db" }>) {
		if (!apps.has(id)) throw new Error(`no app ${id}`);
		const db = database(id);
		const before = totalChanges(db);
		const run = (sql: string, params: SQLInputValue[] = []) => {
			const result = db.prepare(sql).run(...params);
			return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
		};
		let value: unknown;
		if (message.op === "all") value = db.prepare(message.sql ?? "").all(...(message.params ?? []));
		else if (message.op === "get") value = db.prepare(message.sql ?? "").get(...(message.params ?? [])) ?? null;
		else if (message.op === "run") value = run(message.sql ?? "", message.params);
		else {
			db.exec("BEGIN");
			try {
				value = (message.statements ?? []).map((statement) => run(statement.sql, statement.params));
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		}
		if (totalChanges(db) !== before) options.topics.changed(`app:${id}`);
		return value;
	}

	/** Applies the migrations the app's database has not had yet, in one transaction. */
	function migrate(id: string, schema: readonly string[]) {
		const db = database(id);
		const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
		if (version > schema.length) {
			throw new Error(`The ${id} app's data has ${version} migrations, but this version of the app has only ${schema.length}.`);
		}
		if (version === schema.length) return;
		db.exec("BEGIN");
		try {
			for (const sql of schema.slice(version)) db.exec(sql);
			db.exec(`PRAGMA user_version = ${schema.length}`);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}

	/** The agent's view of an app: one extension with its tools, replaced in place when a new version loads. */
	function installTools(app: AppInfo, manifest: Manifest) {
		for (const tool of manifest.tools) {
			if (!tool.name.startsWith(`${app.id}_`)) throw new Error(`The ${app.id} app's tool ${tool.name} must start with "${app.id}_".`);
		}
		options.registry.install(
			defineExtension({
				name: `app.${app.id}`,
				sections: [
					section(
						`app_${app.id}`,
						() =>
							`The user has the ${app.name} app${app.description ? `: ${app.description}` : ""}. Use the ${app.id}_* tools to read and change it; the user sees every change in the app at once.`,
					),
				],
				tools: manifest.tools.map((tool) =>
					defineTool({
						name: tool.name,
						description: tool.description,
						parameters: obj(parameters(tool.params)),
						execute: async (args: Record<string, unknown>) => {
							const value = await call(app.id, "tool", tool.name, args);
							return { output: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] };
						},
					}),
				),
			}),
		);
	}

	async function ready(id: string): Promise<WebSocket> {
		const ws = await connect();
		const failure = failures.get(id);
		if (failure) throw failure;
		if (!loaded.has(id)) {
			await new Promise<Manifest>((resolve, reject) => {
				const waiters = loadWaiters.get(id) ?? [];
				waiters.push({ resolve, reject });
				loadWaiters.set(id, waiters);
			});
		}
		return ws;
	}

	async function call(id: string, kind: Kind, name: string, args: unknown): Promise<unknown> {
		if (!apps.has(id)) throw new Error(`There is no ${id} app.`);
		const ws = await ready(id);
		const manifest = loaded.get(id);
		const known = kind === "source" ? manifest?.sources : kind === "mutation" ? manifest?.mutations : manifest?.tools.map((t) => t.name);
		if (!known?.includes(name)) throw new Error(`The ${id} app has no ${kind} named ${name}.`);
		const callId = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				calls.delete(callId);
				reject(new Error(`The ${id} app did not answer ${name} within ${CALL_TIMEOUT_MS / 1000} s.`));
			}, CALL_TIMEOUT_MS);
			calls.set(callId, { resolve, reject, timer });
			ws.send(JSON.stringify({ t: "call", id: callId, app: id, kind, name, args }));
		});
	}

	/** The app and the name within it of a shell source such as `todosSetDone`, if an app owns it. */
	function route(source: string): { app: string; name: string } | undefined {
		for (const id of apps.keys()) {
			const rest = source.slice(id.length);
			if (source.startsWith(id) && /^[A-Z]/.test(rest)) return { app: id, name: rest[0]!.toLowerCase() + rest.slice(1) };
		}
		return undefined;
	}

	return {
		apps: () => [...apps.values()].map(({ id, name, description, symbol, cover }) => ({ id, name, description, symbol, cover })),
		route,
		call,
		/** Loads every app, so their tools are installed before the agent's first turn. */
		async start() {
			await Promise.all([...apps.keys()].map((id) => ready(id)));
		},
		close() {
			socket?.close();
			for (const db of databases.values()) db.close();
		},
	};
}

export type AppGateway = ReturnType<typeof appGateway>;

const totalChanges = (db: DatabaseSync) => Number((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n);

function parameters(params: Record<string, Param>): Properties {
	const out: Record<string, Schema | ReturnType<typeof opt>> = {};
	for (const [name, param] of Object.entries(params)) {
		const annotations = param.description ? { description: param.description } : {};
		const schema: Schema =
			param.type === "enum"
				? oneOf(param.values, annotations)
				: { string: str, number: num, integer: int, boolean: bool }[param.type](annotations);
		out[name] = param.optional ? opt(schema) : schema;
	}
	return out;
}

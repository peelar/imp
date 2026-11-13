// The host: Pi Durable on SQLite, the agent's machine through the adapter contract, the app gateway, and one HTTP
// origin that serves both the web client and its API. It listens on localhost only; `tailscale serve` is the gate in
// front of it and tells it who signed in. server.ts starts it.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, Harness, section } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { appGateway, readApps } from "./apps.ts";
import { homeChat, TOPIC as CHAT, withAppContext } from "./chat.ts";
import { type LiveSource, serveLive, Topics } from "./live.ts";
import type { Machine, MachineProvider } from "./machine.ts";
import { chatgptAccount, TOPIC as ACCOUNT } from "./signin.ts";

const context = BACKGROUND_CONTEXT;
const MACHINE_KEY = "owner:local";
const KEEP_ALIVE_MS = 60_000;

export interface HostOptions {
	readonly models: Models;
	/** The home conversation's model, on the ChatGPT provider. */
	readonly model: { readonly provider: string; readonly modelId: string };
	readonly machines: (secret: string) => MachineProvider;
	readonly dataDir: string;
	/** The app folders (the client's apps/). */
	readonly appsDir: string;
	/** The built web client, served at /. Absent: the host serves only the API. */
	readonly clientDir?: string;
	readonly port: number;
	/** The Tailscale login allowed in, such as "adrian@github". Absent: everyone on the tailnet. */
	readonly owner?: string;
	readonly machineImage?: string;
}

export async function startHost(options: HostOptions) {
	const DATA = options.dataDir;
	mkdirSync(DATA, { recursive: true });

	// A stable secret for deriving machine tokens, created on first start.
	const secretFile = join(DATA, "host-secret");
	if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString("hex"), { mode: 0o600 });
	const secret = readFileSync(secretFile, "utf8").trim();
	const topics = new Topics();

	// The agent's machine: ensured on first use, then reused. Nothing here names the provider.
	const provider = options.machines(secret);
	let machine: Promise<Machine> | undefined;
	let lastKeepAlive = 0;
	const ensureMachine = () =>
		(machine ??= provider
			.ensure({ key: MACHINE_KEY, image: options.machineImage ?? "base", idleSuspendMs: 10 * 60_000 })
			.then((m) => {
				lastKeepAlive = Date.now();
				return m;
			})
			.catch((error) => {
				machine = undefined;
				throw error;
			}));
	/** The host is using the machine: keep it from suspending, at most once a minute. */
	const touchMachine = () => {
		if (!machine || Date.now() - lastKeepAlive < KEEP_ALIVE_MS) return;
		lastKeepAlive = Date.now();
		machine.then((m) => m.keepAlive()).catch((error) => console.error(`keepAlive: ${error}`));
	};
	// One pi-env connection. It ensures the machine only when a tool first touches files or the shell.
	const connection = new Connection({ command: async () => (await ensureMachine()).daemonCommand() });
	const workspace = provider.workspace(MACHINE_KEY);

	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(
		defineExtension({
			name: "imp",
			sections: [
				section(
					"preamble",
					() =>
						`You are Imp, the user's own imp: a small, clever, loyal helper that runs their errands in the Imp app. You use their apps for them and build new apps when they ask. You have your own Linux computer: the read, write, edit, and bash tools run on it, in ${workspace}. Act without asking, except before destructive or irreversible actions. Keep answers short.`,
					{ tag: false },
				),
			],
		}),
	);

	const gateway = appGateway({
		apps: readApps(options.appsDir),
		dataDir: DATA,
		topics,
		registry,
		machine: async () => {
			const m = await ensureMachine();
			touchMachine();
			return m;
		},
	});

	const account = chatgptAccount(options.models, topics);
	const env = ({ cwd }: { readonly cwd?: string }) =>
		new RemoteExecutionEnv({ connection, id: `machine:${MACHINE_KEY}`, cwd: cwd ?? workspace });
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(DATA, "harness.sqlite")),
		{ models: options.models, registry, env },
		context,
	);
	const agent = { model: options.model, cwd: workspace };
	const home = await harness.root(context, { agent });
	// root() applies `agent` only when it creates the conversation; a changed model or machine applies on every start.
	await home.configure(agent, context);
	const chat = await homeChat(harness, home, topics, gateway.apps, context);
	harness.resume();
	// While the agent works, its tools use the machine.
	topics.on(CHAT, () => {
		void chat.busy().then((busy) => busy && touchMachine());
	});
	// Load every app now, so their tools are there for the agent's first turn. A machine that is down is retried by
	// the first call that needs it.
	gateway.start().catch((error) => console.error(`apps: ${error instanceof Error ? error.message : error}`));

	const ok = { ok: true, error: "" };
	const refused = (error: string) => ({ ok: false, error });

	/** What the shell reads. Each is streamed live; app sources are routed to their app. */
	function live(source: string, args: unknown[]): LiveSource | undefined {
		if (source === "account") return { topics: [ACCOUNT], load: async () => account.state() };
		if (source === "chat") return { topics: [CHAT], load: () => chat.state() };
		if (source === "apps") return { topics: [], load: async () => gateway.apps() };
		const route = gateway.route(source);
		if (route) return { topics: [`app:${route.app}`], load: () => gateway.call(route.app, "source", route.name, args) };
		return undefined;
	}

	/** What the shell changes. Each answers a Reply, `{ ok, error }`. */
	async function mutate(source: string, args: unknown[]): Promise<unknown> {
		switch (source) {
			case "accountSignIn":
				account.start();
				return ok;
			case "accountCancel":
				account.cancel();
				return ok;
			case "accountSignOut":
				await account.signOut();
				return ok;
			case "chatSend": {
				const text = String(args[0] ?? "").trim();
				if (!text) return refused("Write a message first.");
				if (!(await account.usable())) return refused("Sign in with ChatGPT first.");
				// The second argument is the app open beside the chat, "" from the chat tab.
				const open = gateway.apps().find((app) => app.id === args[1]);
				await home.submit({ type: "input", content: withAppContext(text, open), whenBusy: "steer" }, context);
				return ok;
			}
			case "chatStop":
				await home.abort(context);
				return ok;
		}
		const route = gateway.route(source);
		if (!route) return undefined;
		try {
			return await gateway.call(route.app, "mutation", route.name, args);
		} catch (error) {
			return refused(error instanceof Error ? error.message : String(error));
		}
	}

	const server = createServer(async (req, res) => {
		try {
			if (!allowed(req, res, options.owner)) return;
			const url = new URL(req.url ?? "/", "http://host");
			if (req.method === "OPTIONS") return send(res, 204, null);

			const liveMatch = url.pathname.match(/^\/api\/live\/(\w+)$/);
			if (liveMatch && req.method === "GET") {
				const args = JSON.parse(url.searchParams.get("args") ?? "[]");
				const source = live(liveMatch[1]!, Array.isArray(args) ? args : []);
				if (!source) return send(res, 404, { error: `no source ${liveMatch[1]}` });
				return await serveLive(req, res, topics, source);
			}

			const callMatch = url.pathname.match(/^\/api\/call\/(\w+)$/);
			if (callMatch && req.method === "POST") {
				// JSON only: a cross-site form cannot send it without the browser asking first.
				if (!String(req.headers["content-type"]).startsWith("application/json")) return send(res, 415, { error: "JSON only" });
				const args = await readJson(req);
				const reply = await mutate(callMatch[1]!, Array.isArray(args) ? args : []);
				if (reply === undefined) return send(res, 404, { error: `no mutation ${callMatch[1]}` });
				return send(res, 200, reply);
			}

			// The address the browser reached the host at, for a web build that has none baked in (see client/app.ts). The
			// host listens on localhost only, so a proxy in front (`tailscale serve`) set the forwarded headers.
			if (url.pathname === "/assets/host.json" && req.method === "GET") {
				const forwarded = (name: string) => String(req.headers[name] ?? "").split(",")[0]!.trim();
				const proto = forwarded("x-forwarded-proto") || "http";
				const hostname = forwarded("x-forwarded-host") || req.headers.host || `127.0.0.1:${options.port}`;
				return send(res, 200, { origin: `${proto}://${hostname}` });
			}

			if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
			if (options.clientDir && req.method === "GET") return serveClient(options.clientDir, url.pathname, res);
			send(res, 404, { error: "not found" });
		} catch (error) {
			console.error(error);
			if (!res.headersSent) send(res, 500, { error: String(error) });
			else res.end();
		}
	});

	await new Promise<void>((resolve) => server.listen(options.port, "127.0.0.1", resolve));
	console.log(`host on http://127.0.0.1:${options.port}, machine ${provider.name}, model ${options.model.provider}/${options.model.modelId}`);
	return {
		gateway,
		async close() {
			server.closeAllConnections();
			server.close();
			gateway.close();
			connection.close();
			await chat.close();
			await harness.close(context);
		},
	};
}

/**
 * Tailscale Serve connects from localhost and adds who signed in. Without an owner set, the tailnet is the gate;
 * with one, every other login is turned away. Loopback browsers in development may also call from another port.
 */
function allowed(req: IncomingMessage, res: ServerResponse, owner: string | undefined): boolean {
	const login = req.headers["tailscale-user-login"];
	if (owner && login !== owner) {
		send(res, 403, { error: "This Imp belongs to someone else." });
		return false;
	}
	const origin = req.headers.origin;
	if (origin && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
		res.setHeader("access-control-allow-origin", origin);
		res.setHeader("access-control-allow-headers", "content-type");
		res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
		res.setHeader("vary", "origin");
	}
	return true;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	let body = "";
	for await (const chunk of req) body += chunk;
	return body ? JSON.parse(body) : [];
}

function send(res: ServerResponse, status: number, value: unknown) {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	res.end(value === null ? "" : JSON.stringify(value));
}

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".wasm": "application/wasm",
	".png": "image/png",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".webmanifest": "application/manifest+json",
	".plan": "application/octet-stream",
	".txt": "text/plain; charset=utf-8",
};

/**
 * The built web client (`exact web-build --out dist`), served by Exact's static-host rule: a file at the path, else
 * shell.html, from which the client draws the route (or its notfound route).
 */
function serveClient(dir: string, pathname: string, res: ServerResponse) {
	const root = normalize(dir);
	let path = normalize(join(root, decodeURIComponent(pathname)));
	if (path !== root && !path.startsWith(root + sep)) return send(res, 404, { error: "not found" });
	if (!existsSync(path) || statSync(path).isDirectory()) {
		const index = join(path, "index.html");
		path = existsSync(index) ? index : join(root, "shell.html");
	}
	if (!existsSync(path)) return send(res, 404, { error: "the web client is not built" });
	res.writeHead(200, {
		"content-type": TYPES[extname(path)] ?? "application/octet-stream",
		// Files named by their content (`fragment-Cxnx3vsw.js`) never change; app.js, app.plan and the pages change with
		// every publish, so the browser asks again each time and open clients get the new version.
		"cache-control": /-[A-Za-z0-9_]{8}\.[a-z]+$/.test(path) ? "public, max-age=31536000, immutable" : "no-cache",
	});
	res.end(readFileSync(path));
}

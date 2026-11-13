// The host: Pi Durable on SQLite, the agent's machine through the adapter contract, the app gateway, and one HTTP
// origin that serves both the web client and its API. It listens on localhost only; `tailscale serve` is the gate in
// front of it and tells it who signed in. server.ts starts it.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, Harness, section } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { appGateway } from "./apps.ts";
import { homeChat, TOPIC as CHAT, withAppContext } from "./chat.ts";
import { type LiveSource, serveLive, Topics } from "./live.ts";
import { openComputer, TOPIC as COMPUTER } from "./computer.ts";
import type { MachineProvider } from "./machine.ts";
import { TOPIC as MEMORY, type MemorySystem } from "./memory.ts";
import { graphMemory } from "./memory-graph.ts";
import { screenSockets, serveScreenPage } from "./screen.ts";
import { chatgptAccount, TOPIC as ACCOUNT } from "./signin.ts";
import { APPS_TOPIC, BUILD_TOPIC, storedApps, studio } from "./studio.ts";

const context = BACKGROUND_CONTEXT;

export interface HostOptions {
	readonly models: Models;
	/** The home conversation's model, on the ChatGPT provider. */
	readonly model: { readonly provider: string; readonly modelId: string };
	/**
	 * A fixed machine for development and tests, such as the local adapter. Absent: the owner picks the agent's computer
	 * in Settings (Imp cloud, or a computer of theirs on the tailnet).
	 */
	readonly machines?: (secret: string) => MachineProvider;
	readonly dataDir: string;
	/** The app folders (the client's apps/), inside the shell's source. */
	readonly appsDir: string;
	/** The Exact checkout the host builds the shell with. Default: the client's (../../../tools/exact from it). */
	readonly exact?: string;
	/** The built web client, served at /. Absent: the host serves only the API. */
	readonly clientDir?: string;
	readonly port: number;
	/** The Tailscale login allowed in, such as "adrian@github". Absent: everyone on the tailnet. */
	readonly owner?: string;
	/** What the imp remembers about its person, and how (memory.ts). Default: the knowledge graph in memory-graph.ts. */
	readonly memory?: MemorySystem;
	/** The running release's tag ("dev" in a checkout). Open pages reload when the host they reconnect to has another. */
	readonly version?: string;
	/** The GitHub repository releases come from, which the Mac installer downloads Imp.app from. */
	readonly repo?: string;
	/** The Mac installer script, served at /install-mac.sh with this host's address and the repository filled in. */
	readonly macInstaller?: string;
	/** An E2B API key for Imp cloud machines; the owner can also enter one in Settings. Default: E2B_API_KEY. */
	readonly cloudKey?: string;
}

export async function startHost(options: HostOptions) {
	const DATA = options.dataDir;
	mkdirSync(DATA, { recursive: true });

	// A stable secret for deriving machine tokens, created on first start.
	const secretFile = join(DATA, "host-secret");
	if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString("hex"), { mode: 0o600 });
	const secret = readFileSync(secretFile, "utf8").trim();
	const topics = new Topics();

	// The agent's computer, as the owner picked it in Settings. Nothing here names the provider.
	const computer = openComputer({
		dataDir: DATA,
		secret,
		topics,
		fixed: options.machines?.(secret),
		cloudKey: options.cloudKey ?? process.env.E2B_API_KEY,
	});

	const registry = createRegistry();
	registry.install(CodingTools);
	registry.install(
		defineExtension({
			name: "imp",
			sections: [
				section(
					"preamble",
					() =>
						`You are Imp, the user's own imp: a small, clever, loyal helper that runs their errands in the Imp app. You use their apps for them and build new apps when they ask. You have your own Linux computer: the read, write, edit, and bash tools run on it, in ${computer.workspace()}. Act without asking, except before destructive or irreversible actions. Keep answers short.`,
					{ tag: false },
				),
			],
		}),
	);
	// After the preamble, so the prompt says who the imp is before what it remembers.
	const memory = (options.memory ?? graphMemory)({ dataDir: DATA, changed: () => topics.changed(MEMORY) });
	registry.install(memory.extension);

	const stored = storedApps(DATA, options.appsDir, (message) => console.error(message));
	const gateway = appGateway({
		apps: stored.live,
		dataDir: DATA,
		topics,
		registry,
		machine: async () => {
			const m = await computer.machine();
			computer.touch();
			return m;
		},
	});

	const account = chatgptAccount(options.models, topics);
	// Built for each tool call, so a switch reaches the agent's next one.
	const env = ({ cwd }: { readonly cwd?: string }) =>
		new RemoteExecutionEnv({ connection: computer.connection(), id: computer.id(), cwd: cwd ?? computer.workspace() });
	const clientSource = resolve(options.appsDir, "..");
	const apps = studio({
		dataDir: DATA,
		repoAppsDir: options.appsDir,
		clientDir: clientSource,
		exact: options.exact ?? process.env.EXACT ?? resolve(clientSource, "../../../tools/exact"),
		gateway,
		topics,
		registry,
		files: () => env({}),
		workspace: computer.workspace,
		context,
		drafts: stored.drafts,
	});
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(DATA, "harness.sqlite")),
		{ models: options.models, registry, env },
		context,
	);
	const agent = () => ({ model: options.model, cwd: computer.workspace() });
	const home = await harness.root(context, { agent: agent() });
	// root() applies `agent` only when it creates the conversation; a changed model or machine applies on every start,
	// and a switch of computer at once: its apps load on the new machine and the agent works there.
	await home.configure(agent(), context);
	computer.onSwitch(async () => {
		gateway.disconnect();
		await home.configure(agent(), context);
		gateway.start().catch((error) => console.error(`apps: ${error instanceof Error ? error.message : error}`));
	});
	const chat = await homeChat(harness, home, topics, gateway.apps, context);
	harness.resume();
	// While the agent works, its tools use the machine.
	topics.on(CHAT, () => {
		void chat.busy().then((busy) => busy && computer.touch());
	});
	// Load every app now. A machine that is down is retried by the first call that needs it.
	gateway
		.start()
		.then(() => apps.start())
		.catch((error) => console.error(`apps: ${error instanceof Error ? error.message : error}`));

	const ok = { ok: true, error: "" };
	const refused = (error: string) => ({ ok: false, error });

	/** What the shell reads. Each is streamed live; app sources are routed to their app. */
	function live(source: string, args: unknown[]): LiveSource | undefined {
		// The shell's streams are few (see Account in client/app.contract), so the computer's state and what the imp
		// remembers come with the account.
		if (source === "account") {
			return {
				topics: [ACCOUNT, COMPUTER, MEMORY],
				load: async () => ({
					...account.state(),
					computer: await computer.load(),
					memory: { name: memory.name, location: memory.location, entries: await memory.inspect() },
				}),
			};
		}
		if (source === "chat") return { topics: [CHAT], load: () => chat.state() };
		if (source === "apps") return { topics: [APPS_TOPIC], load: async () => apps.state() };
		if (source === "build") return { topics: [BUILD_TOPIC], load: async () => ({ id: apps.buildId() }) };
		if (source === "version") return { topics: [], load: async () => ({ version: options.version ?? "dev" }) };
		if (source === "computer") return { topics: [COMPUTER], load: () => computer.load() };
		const route = gateway.route(source);
		if (route) return { topics: [`app:${route.app}`], load: () => gateway.fromShell(route.app, "read", route.name, args) };
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
			case "memoryForget":
				// An entry, and one of its facts ("" forgets the whole entry).
				await memory.forget(String(args[0] ?? ""), args[1] ? String(args[1]) : undefined);
				return ok;
			case "chatStop":
				await home.abort(context);
				return ok;
			case "appsSave":
			case "appsDiscard":
			case "appsUndo": {
				const id = String(args[0] ?? "");
				const run = source === "appsSave" ? apps.save : source === "appsDiscard" ? apps.discard : apps.undo;
				try {
					await run(id);
					return ok;
				} catch (error) {
					return refused(error instanceof Error ? error.message : String(error));
				}
			}
			case "computerRefresh":
				return computer.refresh();
			case "computerRetry":
				return computer.retry();
			case "computerSetCloudKey":
				if (await chat.busy()) return refused("Wait until your imp finishes, or stop it, then switch.");
				return computer.setCloudKey(String(args[0] ?? ""));
			case "computerUseCloud":
			case "computerUseOwn":
				// A switch mid-turn would cut the agent's tools off from the machine they started on.
				if (await chat.busy()) return refused("Wait until your imp finishes, or stop it, then switch.");
				return source === "computerUseCloud" ? computer.useCloud(String(args[0] ?? "")) : computer.useOwn(String(args[0] ?? ""));
		}
		const route = gateway.route(source);
		if (!route) return undefined;
		try {
			return await gateway.fromShell(route.app, "write", route.name, args);
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

			// The address the browser reached the host at, for a web build that has none baked in (see client/app.ts).
			if (url.pathname === "/assets/host.json" && req.method === "GET") return send(res, 200, { origin: origin(req, options.port) });

			// `curl -fsSL https://<this host>/install-mac.sh | sh` installs the Mac app, already pointed at this host.
			if (url.pathname === "/install-mac.sh" && req.method === "GET" && options.macInstaller) {
				const script = readFileSync(options.macInstaller, "utf8")
					.replaceAll("__IMP_HOST__", origin(req, options.port))
					.replaceAll("__IMP_REPO__", options.repo ?? "");
				res.writeHead(200, { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-store" });
				return res.end(script);
			}

			// The computer's screen, in a tab of its own.
			if (req.method === "GET" && serveScreenPage(url.pathname, res)) return;

			if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
			// The newest shell the host built for its apps, else the one it shipped with.
			const clientDir = apps.clientDir() ?? options.clientDir;
			if (clientDir && req.method === "GET") return serveClient(clientDir, url.pathname, res, options.version ?? "dev");
			send(res, 404, { error: "not found" });
		} catch (error) {
			console.error(error);
			if (!res.headersSent) send(res, 500, { error: String(error) });
			else res.end();
		}
	});

	const screens = screenSockets(computer);
	server.on("upgrade", (req, socket, head) => {
		const owner = !options.owner || req.headers["tailscale-user-login"] === options.owner;
		if (!screens.upgrade(req, socket, head, owner, origin(req, options.port))) socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
	});

	await new Promise<void>((resolve) => server.listen(options.port, "127.0.0.1", resolve));
	console.log(`host on http://127.0.0.1:${options.port}, model ${options.model.provider}/${options.model.modelId}`);
	return {
		gateway,
		/** Whether the agent is between turns. */
		async idle() {
			return !(await chat.busy());
		},
		async close() {
			screens.close();
			server.closeAllConnections();
			server.close();
			gateway.close();
			computer.close();
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

/** The address the request reached the host at. It listens on localhost only, so a proxy in front of it (`tailscale
 * serve`) set the forwarded headers. */
function origin(req: IncomingMessage, port: number): string {
	const forwarded = (name: string) => String(req.headers[name] ?? "").split(",")[0]!.trim();
	const proto = forwarded("x-forwarded-proto") || "http";
	const hostname = forwarded("x-forwarded-host") || req.headers.host || `127.0.0.1:${port}`;
	return `${proto}://${hostname}`;
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
	".jpg": "image/jpeg",
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
function serveClient(dir: string, pathname: string, res: ServerResponse, version: string) {
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
	const body = readFileSync(path);
	res.end(extname(path) === ".html" && version !== "dev" ? withReload(body.toString("utf8"), version) : body);
}

/**
 * A released host's pages reload themselves when the host they reach is another release: the version stream ends when
 * the host restarts into an update, the browser opens it again, and the new host answers with its own version.
 */
function withReload(html: string, version: string): string {
	const script = `<script>new EventSource("/api/live/version").onmessage = (e) => { if (JSON.parse(e.data).version !== ${JSON.stringify(version)}) location.reload(); };</script>`;
	return html.includes("</head>") ? html.replace("</head>", `${script}</head>`) : script + html;
}

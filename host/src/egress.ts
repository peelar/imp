// The egress proxy: how the agent uses the owner's secrets without holding them. Commands on the machine get a
// stand-in and send their HTTPS requests to agentd's proxy there (machine-runtime.ts, egressEnv). agentd sends the
// requests for a secret's hosts to the host, over a stream socket the host opens to it (the machine cannot reach the
// host, but the host reaches every machine); the host passes each stream to mitmproxy on its loopback. mitmproxy ends
// TLS with Imp's own CA, which agentd adds to the machine's CA bundle, and its addon (egress/inject.py) puts the secret
// on the request and takes it out of the response. The host records each use.
//
//   DATA_DIR/egress/ca/        mitmproxy's CA (its private key never leaves the host)
//   DATA_DIR/egress/rules.json which secret goes on which host's requests, and their stand-ins: names, no values
//   DATA_DIR/egress/token      a vault token that only reads values, replaced every half hour
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { createWebSocketStream } from "ws";
import type { Machine } from "./machine.ts";
import { tool } from "./tools.ts";
import type { Vault } from "./vault.ts";

const ADDON = join(dirname(fileURLToPath(import.meta.url)), "..", "egress", "inject.py");
const TOKEN_ROTATE_MS = 30 * 60_000;

/** One header a secret is put in, on requests to one host. */
export interface EgressRule {
	readonly secret: string;
	readonly header: string;
	/** Written before the value, such as "Bearer ". */
	readonly prefix: string;
	/** Set for HTTP basic auth: the value goes in as base64 of `<basicUser>:<value>`. */
	readonly basicUser?: string;
}

export interface EgressRules {
	readonly hosts: Readonly<Record<string, readonly EgressRule[]>>;
	readonly standIns: Readonly<Record<string, string>>;
}

/** One use of a secret, as the addon reports it. */
export interface EgressUse {
	readonly secret: string;
	readonly method: string;
	readonly host: string;
	readonly path: string;
	readonly status: number;
	readonly error: string;
}

export interface EgressOptions {
	readonly dataDir: string;
	readonly toolsDir: string;
	readonly vault: Vault;
	readonly onUse: (use: EgressUse) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const children = new Set<ChildProcess>();
process.once("exit", () => {
	for (const child of children) child.kill();
});

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
		});
	});
}

function accepts(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(port, "127.0.0.1");
		socket.once("connect", () => (socket.destroy(), resolve(true)));
		socket.once("error", () => resolve(false));
	});
}

export function openEgress(options: EgressOptions) {
	const dir = join(options.dataDir, "egress");
	const caDir = join(dir, "ca");
	const log = join(dir, "mitmdump.log");
	mkdirSync(caDir, { recursive: true, mode: 0o700 });
	let rules: EgressRules = { hosts: {}, standIns: {} };
	let proxy: { child: ChildProcess; port: number } | undefined;
	let starting: Promise<{ child: ChildProcess; port: number }> | undefined;
	let rotation: NodeJS.Timeout | undefined;
	let accessor = "";
	let closed = false;
	/** The control socket to the current machine's agentd, and the machine it belongs to. */
	let control: { machine: Machine; ws: WebSocket; configured: Promise<void> } | undefined;

	/** Writes a file whole: the addon never reads half of one. */
	const writeAtomic = (name: string, content: string) => {
		const path = join(dir, name);
		writeFileSync(`${path}.tmp`, content, { mode: 0o600 });
		renameSync(`${path}.tmp`, path);
	};

	/** A new read-only vault token for the addon; the one it replaces is revoked a minute later. */
	async function rotateToken() {
		const next = await options.vault.egressToken();
		writeAtomic("token", next.token);
		const previous = accessor;
		accessor = next.accessor;
		if (previous) setTimeout(() => void options.vault.revoke(previous).catch(() => {}), 60_000).unref();
	}

	async function start() {
		const mitmdump = await tool(options.toolsDir, "mitmdump");
		await options.vault.ready();
		writeAtomic("rules.json", JSON.stringify(rules));
		await rotateToken();
		rotation ??= setInterval(() => void rotateToken().catch((e) => console.error(`egress token: ${e.message}`)), TOKEN_ROTATE_MS);
		rotation.unref();
		const port = await freePort();
		const child = spawn(
			mitmdump,
			[
				...["--mode", `regular@127.0.0.1:${port}`],
				...["--set", `confdir=${caDir}`],
				// Large bodies (downloads, git packs) stream through; only buffered ones are scrubbed of a value.
				...["--set", "stream_large_bodies=1m"],
				...["--set", "termlog_verbosity=warn", "--set", "flow_detail=0"],
				...["-s", ADDON],
			],
			{
				stdio: ["ignore", "pipe", "pipe"],
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, IMP_EGRESS_DIR: dir, IMP_VAULT_SOCKET: options.vault.socket },
			},
		);
		children.add(child);
		let pending = "";
		child.stdout!.setEncoding("utf8");
		child.stdout!.on("data", (chunk: string) => {
			pending += chunk;
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) {
				const at = line.indexOf("IMP-USE ");
				if (at === -1) {
					if (line.trim()) appendFileSync(log, `${line}\n`);
					continue;
				}
				try {
					options.onUse(JSON.parse(line.slice(at + 8)) as EgressUse);
				} catch {
					appendFileSync(log, `${line}\n`);
				}
			}
		});
		child.stderr!.on("data", (chunk) => appendFileSync(log, chunk));
		child.on("exit", (code) => {
			children.delete(child);
			if (proxy?.child === child) proxy = undefined;
			if (!closed) appendFileSync(log, `mitmdump exited (${code})\n`);
		});
		for (let i = 0; i < 300; i++) {
			if (child.exitCode !== null) break;
			if (existsSync(join(caDir, "mitmproxy-ca-cert.pem")) && (await accepts(port))) return { child, port };
			await sleep(100);
		}
		child.kill();
		const tail = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").slice(-5).join("\n") : "";
		throw new Error(`The egress proxy did not start. ${tail}`);
	}

	/** mitmproxy, running. */
	function running() {
		if (closed) return Promise.reject(new Error("The egress proxy is closed."));
		if (proxy && proxy.child.exitCode === null) return Promise.resolve(proxy);
		return (starting ??= start()
			.then((started) => (proxy = started))
			.finally(() => {
				starting = undefined;
			}));
	}

	const config = () =>
		JSON.stringify({ t: "config", hosts: Object.keys(rules.hosts), ca: readFileSync(join(caDir, "mitmproxy-ca-cert.pem"), "utf8") });

	/** A tunnel agentd asked for: a stream socket to it, piped into mitmproxy. */
	async function openStream(socket: { url: string; headers: Readonly<Record<string, string>> }, id: string) {
		const { port } = await running();
		const ws = new WebSocket(`${socket.url}&stream=${encodeURIComponent(id)}`, { headers: { ...socket.headers } });
		const stream = createWebSocketStream(ws);
		const upstream = connect(port, "127.0.0.1");
		stream.on("error", () => upstream.destroy());
		upstream.on("error", () => stream.destroy());
		stream.pipe(upstream).pipe(stream);
	}

	/** Opens the control socket to `machine`'s agentd, replacing one to another machine, and sends it the rules. */
	async function connectTo(machine: Machine) {
		const { socket } = await machine.egress();
		await running();
		const ws = new WebSocket(socket.url, { headers: { ...socket.headers } });
		let configured!: () => void;
		const current = { machine, ws, configured: new Promise<void>((resolve) => (configured = resolve)) };
		control?.ws.close();
		control = current;
		ws.on("open", () => ws.send(config()));
		ws.on("message", (data) => {
			const message = JSON.parse(String(data)) as { t: string; id?: string };
			if (message.t === "configured") configured();
			else if (message.t === "open" && message.id) {
				void openStream(socket, message.id).catch((e) => console.error(`egress stream: ${e instanceof Error ? e.message : e}`));
			}
		});
		ws.on("error", (e) => console.error(`egress control: ${e.message}`));
		ws.on("close", () => {
			if (control === current) control = undefined;
			configured();
		});
		return current;
	}

	return {
		/**
		 * The control socket to `machine` is open and agentd has the current rules, so a command started now has its
		 * requests to a secret's hosts reach the host. Waits at most 20 seconds.
		 */
		async connect(machine: Machine) {
			const current = control && control.machine === machine && control.ws.readyState <= WebSocket.OPEN ? control : await connectTo(machine);
			await Promise.race([current.configured, sleep(20_000)]);
		},
		/** New rules: the addon reads them at once, and the machine connected now learns its hosts. */
		setRules(next: EgressRules) {
			rules = next;
			if (proxy || starting) writeAtomic("rules.json", JSON.stringify(rules));
			if (control?.ws.readyState === WebSocket.OPEN) control.ws.send(config());
		},
		/** The agent moved to another machine: drop the control socket; the next command opens one there. */
		disconnect() {
			control?.ws.close();
			control = undefined;
		},
		close() {
			closed = true;
			control?.ws.close();
			if (rotation) clearInterval(rotation);
			proxy?.child.kill();
		},
	};
}

export type Egress = ReturnType<typeof openEgress>;

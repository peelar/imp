// The machine runtime, one process on the agent's machine. The host reaches it through the adapter's port forwarding,
// and every connection must present the machine's token.
//
// /health   answers with a hash of the token and the runtime's version, so the host can tell whether this agentd is
//           the one it would start.
// /pi-env   carries a pi-env daemon's stdin and stdout over a WebSocket. Frames to the host start with one byte: 1 for
//           stdout, 2 for stderr. Frames from the host are the daemon's stdin.
// /apps     the app daemon: the host loads each app's server code, and agentd runs it in a worker of its own, so a
//           new version replaces the old worker and terminating it frees everything. One host connection at a time;
//           workers keep running when it drops, and the host loads every app again when it reconnects.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { WebSocketServer } from "./node_modules/ws/wrapper.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.AGENTD_PORT ?? 7070);
const token = process.env.AGENTD_TOKEN;
const daemon = process.env.PI_ENV_PATH;
const home = process.env.MACHINE_HOME ?? process.env.HOME;
if (!token || !daemon) throw new Error("AGENTD_TOKEN and PI_ENV_PATH are required");

// The digest names the runtime files' version, so a host with newer files restarts an older agentd.
const tokenHash = createHash("sha256").update(`${token}:${process.env.AGENTD_DIGEST ?? ""}`).digest("hex");
const server = createServer((req, res) => {
	res.writeHead(req.url === "/health" ? 200 : 404).end(req.url === "/health" ? tokenHash : "");
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

server.on("upgrade", (req, socket, head) => {
	const url = new URL(req.url ?? "/", "http://agentd");
	if (url.searchParams.get("token") !== token || (url.pathname !== "/pi-env" && url.pathname !== "/apps")) {
		socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
		return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => {
		if (url.pathname === "/pi-env") servePiEnv(ws, JSON.parse(url.searchParams.get("args") ?? "[]"));
		else serveApps(ws);
	});
});

function servePiEnv(ws, args) {
	const child = spawn(daemon, args, { stdio: ["pipe", "pipe", "pipe"], cwd: home });
	const send = (kind, chunk) => {
		if (ws.readyState === ws.OPEN) ws.send(Buffer.concat([Buffer.from([kind]), chunk]));
	};
	child.stdout.on("data", (chunk) => send(1, chunk));
	child.stderr.on("data", (chunk) => send(2, chunk));
	child.on("exit", (code) => ws.close(1000, String(code ?? "")));
	ws.on("message", (data) => child.stdin.write(data));
	ws.on("close", () => child.kill("SIGTERM"));
}

// ---- The app daemon ----

/** app id -> { hash, worker, manifest, pending: Map<id, reply> } */
const apps = new Map();
let host; // the one host connection
let nextDbId = 1;
/** db request id (host-facing) -> { worker, id (worker-facing) } */
const dbWaiting = new Map();

const toHost = (message) => {
	if (host?.readyState === host?.OPEN) host.send(JSON.stringify(message));
};

function serveApps(ws) {
	host?.close(4000, "replaced by a newer host connection");
	host = ws;
	ws.on("message", (data) => {
		const message = JSON.parse(String(data));
		if (message.t === "load") load(message.app, message.hash, message.code);
		else if (message.t === "unload") unload(message.app);
		else if (message.t === "call") call(message);
		else if (message.t === "dbResult") {
			const waiting = dbWaiting.get(message.id);
			dbWaiting.delete(message.id);
			waiting?.worker.postMessage({ ...message, id: waiting.id });
		}
	});
	ws.on("close", () => {
		if (host !== ws) return;
		host = undefined;
		// No host means no data: fail every database call still waiting for one.
		for (const [id, waiting] of dbWaiting) {
			waiting.worker.postMessage({ t: "dbResult", id: waiting.id, ok: false, error: "the host disconnected" });
			dbWaiting.delete(id);
		}
	});
}

function load(appId, hash, code) {
	const current = apps.get(appId);
	if (current?.hash === hash) {
		toHost({ t: "loaded", app: appId, hash, manifest: current.manifest });
		return;
	}
	const worker = new Worker(join(here, "worker.mjs"), {
		workerData: { appId, code },
		resourceLimits: { maxOldGenerationSizeMb: 256 },
		stdout: false,
		stderr: false,
	});
	const entry = { hash, worker, manifest: undefined, pending: new Map(), ready: false };
	worker.on("message", (message) => {
		if (message.t === "ready") {
			entry.ready = true;
			entry.manifest = message.manifest;
			const previous = apps.get(appId);
			apps.set(appId, entry);
			if (previous && previous !== entry) retire(previous);
			toHost({ t: "loaded", app: appId, hash, manifest: message.manifest });
		} else if (message.t === "failed") {
			worker.terminate();
			toHost({ t: "loadFailed", app: appId, hash, error: message.error });
		} else if (message.t === "result") {
			const reply = entry.pending.get(message.id);
			entry.pending.delete(message.id);
			reply?.(message);
			if (entry.retiring && entry.pending.size === 0) worker.terminate();
		} else if (message.t === "db") {
			const id = nextDbId++;
			if (!host) {
				worker.postMessage({ t: "dbResult", id: message.id, ok: false, error: "the host is not connected" });
				return;
			}
			dbWaiting.set(id, { worker, id: message.id });
			toHost({ t: "db", id, app: appId, op: message.op, sql: message.sql, params: message.params, statements: message.statements });
		}
	});
	worker.on("error", (error) => {
		failPending(entry, `the app worker crashed: ${error.message}`);
		if (!entry.ready) toHost({ t: "loadFailed", app: appId, hash, error: error.stack ?? String(error) });
		if (apps.get(appId) === entry) apps.delete(appId);
	});
	worker.on("exit", () => {
		failPending(entry, "the app worker exited");
		if (apps.get(appId) === entry) apps.delete(appId);
	});
}

/** A replaced worker finishes the calls it has, then exits. */
function retire(entry) {
	entry.retiring = true;
	if (entry.pending.size === 0) entry.worker.terminate();
}

function unload(appId) {
	const entry = apps.get(appId);
	apps.delete(appId);
	if (entry) retire(entry);
}

function failPending(entry, error) {
	for (const reply of entry.pending.values()) reply({ ok: false, error });
	entry.pending.clear();
}

function call(message) {
	const entry = apps.get(message.app);
	const reply = (result) => toHost({ t: "result", id: message.id, ok: result.ok, value: result.value, error: result.error });
	if (!entry) {
		reply({ ok: false, error: `app ${message.app} is not loaded` });
		return;
	}
	entry.pending.set(message.id, reply);
	entry.worker.postMessage({ t: "call", id: message.id, kind: message.kind, name: message.name, args: message.args });
}

server.listen(port, process.env.AGENTD_HOST ?? "0.0.0.0", () => console.log(`agentd listening on ${port}`));

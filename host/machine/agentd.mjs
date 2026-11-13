// The machine runtime, one process on the agent's machine. The host reaches it through the adapter's port forwarding,
// and every connection must present the machine's token.
//
// /health   answers with a hash of the token and the runtime's version, so the host can tell whether this agentd is
//           the one it would start.
// /pi-env   carries a pi-env daemon's stdin and stdout over a WebSocket. Frames to the host start with one byte: 1 for
//           stdout, 2 for stderr. Frames from the host are the daemon's stdin.
// /screen   the computer's screen: a VNC (RFB) stream over a WebSocket, bridged to x11vnc's socket (see screen.sh).
// /egress  the egress proxy's control socket (see "The egress proxy" below), and with `&stream=<id>` one tunnel.
// /apps     the app daemon: the host loads each app's server code, and agentd runs it in a worker of its own, so a
//           new version replaces the old worker and terminating it frees everything. One host connection at a time;
//           workers keep running when it drops, and the host loads every app again when it reconnects.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { createWebSocketStream, WebSocketServer } from "./node_modules/ws/wrapper.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.AGENTD_PORT ?? 7070);
const token = process.env.AGENTD_TOKEN;
const daemon = process.env.PI_ENV_PATH;
const home = process.env.MACHINE_HOME ?? process.env.HOME;
if (!token || !daemon)
  throw new Error("AGENTD_TOKEN and PI_ENV_PATH are required");

// The digest names the runtime files' version, so a host with newer files restarts an older agentd.
const tokenHash = createHash("sha256")
  .update(`${token}:${process.env.AGENTD_DIGEST ?? ""}`)
  .digest("hex");
const server = createServer((req, res) => {
  res
    .writeHead(req.url === "/health" ? 200 : 404)
    .end(req.url === "/health" ? tokenHash : "");
});
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 64 * 1024 * 1024,
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://agentd");
  if (
    url.searchParams.get("token") !== token ||
    !["/pi-env", "/apps", "/screen"].includes(url.pathname)
  ) {
    socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (url.pathname === "/pi-env")
      servePiEnv(ws, JSON.parse(url.searchParams.get("args") ?? "[]"));
    else if (url.pathname === "/screen") serveScreen(ws);
    else serveApps(ws);
  });
});

function servePiEnv(ws, args) {
  // With the screen up, the agent's programs open their windows on it.
  const env = screenUp
    ? { ...process.env, DISPLAY: SCREEN_DISPLAY }
    : process.env;
  const child = spawn(daemon, args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: home,
    env,
  });
  const send = (kind, chunk) => {
    if (ws.readyState === ws.OPEN)
      ws.send(Buffer.concat([Buffer.from([kind]), chunk]));
  };
  child.stdout.on("data", (chunk) => send(1, chunk));
  child.stderr.on("data", (chunk) => send(2, chunk));
  child.on("exit", (code) => ws.close(1000, String(code ?? "")));
  ws.on("message", (data) => child.stdin.write(data));
  ws.on("close", () => child.kill("SIGTERM"));
}

// ---- The screen ----

const SCREEN_DISPLAY = ":99";
const SCREEN_SOCKET = join(home, ".cache", "imp", "screen.sock");
let screenUp = false;
let screenStarting;

/** Starts whatever of the screen is not running; true when it is up. Concurrent calls share one run. */
function startScreen() {
  screenStarting ??= new Promise((resolve) => {
    const child = spawn("/bin/sh", [join(here, "screen.sh")], {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, SCREEN_DISPLAY, SCREEN_SOCKET },
    });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  }).then((up) => {
    screenUp = up;
    screenStarting = undefined;
    return up;
  });
  return screenStarting;
}

function serveScreen(ws) {
  let vnc;
  const queued = [];
  ws.on("message", (data) => (vnc ? vnc.write(data) : queued.push(data)));
  ws.on("close", () => vnc?.destroy());
  // Started again on every connection, in case part of it stopped since.
  startScreen().then((up) => {
    if (ws.readyState !== ws.OPEN) return;
    if (!up)
      return ws.close(1011, "The screen did not start on this computer.");
    vnc = connect(SCREEN_SOCKET);
    vnc.on("connect", () => {
      for (const data of queued.splice(0)) vnc.write(data);
    });
    vnc.on("data", (chunk) => ws.readyState === ws.OPEN && ws.send(chunk));
    vnc.on("error", () => ws.close(1011, "The screen stopped."));
    vnc.on("close", () => ws.close(1000));
  });
}

// ---- The egress proxy ----
//
// The agent's commands send their HTTPS requests here (HTTPS_PROXY, on the machine's loopback). A request to a host
// one of the owner's secrets is for goes to the host, which puts the secret on it: the host keeps a control socket
// open, agentd asks it over that socket to open a stream socket for each tunnel, and passes the tunnel's bytes through
// as they came, CONNECT line included. The host answers the CONNECT itself. Every other request goes out from here
// directly, as it would without the proxy. The rule list holds host names only; values never come to the machine.

const EGRESS_PORT = Number(process.env.EGRESS_PORT ?? 7071);
const EGRESS_DIR = process.env.EGRESS_DIR ?? join(home, ".cache", "imp");
/** The host names whose requests go to the host. */
let egressHosts = new Set();
let egressControl;
/** Waiting for the host's control socket: resolved with it. */
let controlWaiters = [];
/** stream id -> the client's socket and what it sent so far */
const tunnels = new Map();
const SYSTEM_BUNDLES = ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/cert.pem"];

function serveEgress(ws, stream) {
	if (stream) {
		const tunnel = tunnels.get(stream);
		tunnels.delete(stream);
		if (!tunnel) return ws.close(1008, "no such tunnel");
		clearTimeout(tunnel.timer);
		const duplex = createWebSocketStream(ws);
		duplex.on("error", () => tunnel.socket.destroy());
		tunnel.socket.on("error", () => duplex.destroy());
		duplex.write(tunnel.head);
		tunnel.socket.pipe(duplex).pipe(tunnel.socket);
		tunnel.socket.resume();
		return;
	}
	egressControl?.close(4000, "replaced by a newer host connection");
	egressControl = ws;
	ws.on("message", (data) => {
		const message = JSON.parse(String(data));
		if (message.t !== "config") return;
		egressHosts = new Set(message.hosts.map((h) => h.toLowerCase()));
		if (message.ca) writeCa(message.ca);
		ws.send(JSON.stringify({ t: "configured" }));
		for (const resolve of controlWaiters.splice(0)) resolve(ws);
	});
	ws.on("close", () => {
		if (egressControl === ws) egressControl = undefined;
	});
}

/** The CA certificate, and a bundle of the system's CAs with it, for the commands' environment (see egressEnv). */
function writeCa(pem) {
	mkdirSync(EGRESS_DIR, { recursive: true, mode: 0o700 });
	const caFile = join(EGRESS_DIR, "egress-ca.pem");
	const bundleFile = join(EGRESS_DIR, "ca-bundle.pem");
	const system = SYSTEM_BUNDLES.find((file) => existsSync(file));
	const bundle = `${system ? readFileSync(system, "utf8").trimEnd() + "\n" : ""}${pem.trim()}\n`;
	const current = existsSync(bundleFile) ? readFileSync(bundleFile, "utf8") : "";
	writeFileSync(caFile, `${pem.trim()}\n`);
	if (current !== bundle) writeFileSync(bundleFile, bundle);
}

/** The host's control socket once it sent its rules; undefined after `ms` without one. */
function hostControl(ms) {
	if (egressControl?.readyState === egressControl?.OPEN && egressControl) return Promise.resolve(egressControl);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			controlWaiters = controlWaiters.filter((w) => w !== done);
			resolve(undefined);
		}, ms);
		const done = (ws) => (clearTimeout(timer), resolve(ws));
		controlWaiters.push(done);
	});
}

const refuse = (socket, status, reason) =>
	socket.end(`HTTP/1.1 ${status}\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(reason)}\r\nconnection: close\r\n\r\n${reason}`);

const egressServer = createTcpServer((socket) => {
	let head = Buffer.alloc(0);
	socket.on("error", () => {});
	const onData = (chunk) => {
		head = Buffer.concat([head, chunk]);
		const end = head.indexOf("\r\n\r\n");
		if (end === -1) {
			if (head.length > 16384) refuse(socket, "431 Request Header Fields Too Large", "");
			return;
		}
		socket.off("data", onData);
		socket.pause();
		const [method, target] = head.subarray(0, head.indexOf("\r\n")).toString("latin1").split(" ");
		const match = /^\[?([^\]]+?)\]?:(\d+)$/.exec(target ?? "");
		if (method !== "CONNECT" || !match) {
			return refuse(socket, "405 Method Not Allowed", "Imp's proxy only carries HTTPS (CONNECT).\n");
		}
		const [, hostname, port] = match;
		if (egressHosts.has(hostname.toLowerCase()) && port === "443") void viaHost(socket, head);
		else direct(socket, hostname, Number(port), head.subarray(end + 4));
	};
	socket.on("data", onData);
});

async function viaHost(socket, head) {
	const control = await hostControl(10_000);
	if (!control) return refuse(socket, "502 Bad Gateway", "Imp's host is not connected to this computer, so it cannot add your secret. Try again in a moment.\n");
	const id = randomUUID();
	const timer = setTimeout(() => {
		if (tunnels.delete(id)) refuse(socket, "504 Gateway Timeout", "Imp's host did not open the tunnel.\n");
	}, 15_000);
	tunnels.set(id, { socket, head, timer });
	socket.on("close", () => {
		if (tunnels.delete(id)) clearTimeout(timer);
	});
	control.send(JSON.stringify({ t: "open", id }));
}

function direct(socket, hostname, port, rest) {
	const upstream = connect(port, hostname);
	upstream.on("connect", () => {
		socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
		if (rest.length > 0) upstream.write(rest);
		socket.pipe(upstream).pipe(socket);
		socket.resume();
	});
	upstream.on("error", (error) => {
		if (!socket.writableEnded) refuse(socket, "502 Bad Gateway", `Could not reach ${hostname}:${port}: ${error.message}\n`);
		socket.destroy();
	});
	socket.on("close", () => upstream.destroy());
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
      waiting.worker.postMessage({
        t: "dbResult",
        id: waiting.id,
        ok: false,
        error: "the host disconnected",
      });
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
  const entry = {
    hash,
    worker,
    manifest: undefined,
    pending: new Map(),
    ready: false,
  };
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
        worker.postMessage({
          t: "dbResult",
          id: message.id,
          ok: false,
          error: "the host is not connected",
        });
        return;
      }
      dbWaiting.set(id, { worker, id: message.id });
      toHost({
        t: "db",
        id,
        app: appId,
        op: message.op,
        sql: message.sql,
        params: message.params,
        statements: message.statements,
      });
    }
  });
  worker.on("error", (error) => {
    failPending(entry, `the app worker crashed: ${error.message}`);
    if (!entry.ready)
      toHost({
        t: "loadFailed",
        app: appId,
        hash,
        error: error.stack ?? String(error),
      });
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
  const reply = (result) =>
    toHost({
      t: "result",
      id: message.id,
      ok: result.ok,
      value: result.value,
      error: result.error,
    });
  if (!entry) {
    reply({ ok: false, error: `app ${message.app} is not loaded` });
    return;
  }
  entry.pending.set(message.id, reply);
  entry.worker.postMessage({
    t: "call",
    id: message.id,
    name: message.name,
    args: message.args,
  });
}

server.listen(port, process.env.AGENTD_HOST ?? "0.0.0.0", () =>
  console.log(`agentd listening on ${port}`)
);
// The screen starts with the machine, so the agent's programs have a display before anyone opens it.
void startScreen().then((up) =>
  console.log(up ? `screen on ${SCREEN_DISPLAY}` : "no screen")
);

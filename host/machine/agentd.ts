// The machine runtime, one process on the agent's machine. The host reaches it through the adapter's port forwarding,
// and every connection must present the machine's token.
//
// /health   answers with a hash of the token and the runtime's version, so the host can tell whether this agentd is
//           the one it would start.
// /pi-env   carries a pi-env daemon's stdin and stdout over a WebSocket. Frames to the host start with one byte: 1 for
//           stdout, 2 for stderr. Frames from the host are the daemon's stdin.
// /screen   the computer's screen: a VNC (RFB) stream over a WebSocket, bridged to x11vnc's socket (see screen.sh).
// /egress   the egress proxy's control socket (see egress.ts), and with `&stream=<id>` one tunnel.
// /apps     the app daemon: the host loads each app's server code, and agentd runs it in a worker of its own, so a
//           new version replaces the old worker and terminating it frees everything. One host connection at a time;
//           workers keep running when it drops, and the host loads every app again when it reconnects.
//
// The host strips this file's types and installs it on the machine as agentd.mjs (src/machine-runtime.ts), beside
// worker.mjs, egress.mjs and the ws package. Import only types, Node's own modules and ws.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import type { Json } from "../../sdk/app.ts";
import type {
  FromAgentd,
  FromWorker,
  ReportedManifest,
  ToAgentd,
  ToWorker,
} from "../src/protocol.ts";
import { egressProxy } from "./egress.ts";

type Outcome = { ok: true; value: Json } | { ok: false; error: string };

type AppEntry = {
  readonly hash: string;
  readonly worker: Worker;
  /** Call id -> how to answer the host. */
  readonly pending: Map<string, (outcome: Outcome) => void>;
  /** Set once the worker reported it: the app is loaded. */
  manifest: ReportedManifest | undefined;
  /** A newer version replaced this one: it exits once its calls are answered. */
  retiring: boolean;
};

const here = import.meta.dirname;
const port = Number(process.env.AGENTD_PORT ?? 7070);
const token = process.env.AGENTD_TOKEN;
const daemon = process.env.PI_ENV_PATH;
const home = process.env.MACHINE_HOME ?? homedir();

if (!token || !daemon) {
  throw new Error("AGENTD_TOKEN and PI_ENV_PATH are required");
}

// The digest names the runtime files' version, so a host with newer files restarts an older agentd.
const tokenHash = createHash("sha256")
  .update(`${token}:${process.env.AGENTD_DIGEST ?? ""}`)
  .digest("hex");

const server = createServer((req, res) => {
  res
    .writeHead(req.url === "/health" ? 200 : 404)
    .end(req.url === "/health" ? tokenHash : "");
});

// Where the agent's commands send their HTTPS requests, so the host can put the owner's secrets on them.
const egress = egressProxy({
  port: Number(process.env.EGRESS_PORT ?? 7071),
  dir: process.env.EGRESS_DIR ?? path.join(home, ".cache", "imp"),
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 64 * 1024 * 1024,
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://agentd");

  if (
    url.searchParams.get("token") !== token ||
    !["/pi-env", "/apps", "/screen", "/egress"].includes(url.pathname)
  ) {
    socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");

    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    if (url.pathname === "/pi-env") {
      // SAFETY: only the host holds the token, and its bridge client sends the daemon's arguments as a JSON array
      // of strings (src/bridge-client.ts).
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse is typed `any`.
      const args = JSON.parse(url.searchParams.get("args") ?? "[]") as string[];

      servePiEnv(ws, daemon, args);
    } else if (url.pathname === "/screen") {
      serveScreen(ws);
    } else if (url.pathname === "/egress") {
      egress.serve(ws, url.searchParams.get("stream"));
    } else {
      serveApps(ws);
    }
  });
});

function servePiEnv(ws: WebSocket, command: string, args: readonly string[]) {
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: home,
    // With the screen up, the agent's programs open their windows on it.
    env: screenUp ? { ...process.env, DISPLAY: SCREEN_DISPLAY } : process.env,
  });

  const send = (kind: 1 | 2, chunk: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(Buffer.concat([Buffer.from([kind]), chunk]));
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    send(1, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    send(2, chunk);
  });
  child.on("exit", (code) => {
    ws.close(1000, String(code ?? ""));
  });
  ws.on("message", (data) => {
    child.stdin.write(bytes(data));
  });
  ws.on("close", () => {
    child.kill("SIGTERM");
  });
}

const bytes = (data: RawData) => {
  if (Buffer.isBuffer(data)) {
    return data;
  }

  return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
};

// ---- The screen ----

const SCREEN_DISPLAY = ":99";
const SCREEN_SOCKET = path.join(home, ".cache", "imp", "screen.sock");
let screenUp = false;
let screenStarting: Promise<boolean> | undefined;

/** Starts whatever of the screen is not running; true when it is up. Concurrent calls share one run. */
async function startScreen() {
  screenStarting ??= (async () => {
    screenUp = await runScreenScript();
    screenStarting = undefined;

    return screenUp;
  })();

  return await screenStarting;
}

async function runScreenScript() {
  return await new Promise<boolean>((resolve) => {
    const child = spawn("/bin/sh", [path.join(here, "screen.sh")], {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, SCREEN_DISPLAY, SCREEN_SOCKET },
    });

    child.on("error", () => {
      resolve(false);
    });
    child.on("exit", (code) => {
      resolve(code === 0);
    });
  });
}

function serveScreen(ws: WebSocket) {
  let vnc: Socket | undefined;
  /** What the viewer sent before the screen was up. */
  const early: Buffer[] = [];

  ws.on("message", (data) => {
    if (vnc) {
      vnc.write(bytes(data));
    } else {
      early.push(bytes(data));
    }
  });
  ws.on("close", () => {
    vnc?.destroy();
  });

  const bridge = async () => {
    // Started again on every connection, in case part of it stopped since.
    const up = await startScreen();

    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }

    if (!up) {
      ws.close(1011, "The screen did not start on this computer.");

      return;
    }

    // A socket queues what is written before it connects, so the viewer's bytes keep their order.
    vnc = connect(SCREEN_SOCKET);

    for (const data of early.splice(0)) {
      vnc.write(data);
    }

    vnc.on("data", (chunk: Buffer) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(chunk);
      }
    });
    vnc.on("error", () => {
      ws.close(1011, "The screen stopped.");
    });
    vnc.on("close", () => {
      ws.close(1000);
    });
  };

  bridge().catch((cause: unknown) => {
    console.error(`agentd: the screen bridge failed: ${String(cause)}`);
    ws.close(1011, "The screen stopped.");
  });
}

// ---- The app daemon ----

const apps = new Map<string, AppEntry>();

/** The one host connection. */
let host: WebSocket | undefined;
let nextDbId = 1;

/** A database request's host-facing id -> the worker that asked and the id it used. */
const dbWaiting = new Map<number, { worker: Worker; id: number }>();

const toHost = (message: FromAgentd) => {
  if (host?.readyState === WebSocket.OPEN) {
    host.send(JSON.stringify(message));
  }
};

const toWorker = (worker: Worker, message: ToWorker) => {
  worker.postMessage(message);
};

function serveApps(ws: WebSocket) {
  host?.close(4000, "replaced by a newer host connection");
  host = ws;
  ws.on("message", (data) => {
    // SAFETY: only the host holds the token, and it sends ToAgentd (src/app-machine.ts).
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse is typed `any`.
    fromHost(JSON.parse(bytes(data).toString("utf-8")) as ToAgentd);
  });
  ws.on("close", () => {
    if (host !== ws) {
      return;
    }

    host = undefined;

    // No host means no data: fail every database call still waiting for one.
    for (const [id, waiting] of dbWaiting) {
      toWorker(waiting.worker, {
        t: "dbResult",
        id: waiting.id,
        ok: false,
        error: "the host disconnected",
      });
      dbWaiting.delete(id);
    }
  });
}

function fromHost(message: ToAgentd) {
  if (message.t === "load") {
    load(message);
  } else if (message.t === "unload") {
    unload(message.app);
  } else if (message.t === "call") {
    call(message);
  } else {
    const waiting = dbWaiting.get(message.id);

    dbWaiting.delete(message.id);

    if (waiting) {
      toWorker(waiting.worker, { ...message, id: waiting.id });
    }
  }
}

function load({ app, hash, code }: Extract<ToAgentd, { t: "load" }>) {
  const current = apps.get(app);

  if (current?.hash === hash && current.manifest) {
    toHost({ t: "loaded", app, hash, manifest: current.manifest });

    return;
  }

  const worker = new Worker(path.join(here, "worker.mjs"), {
    workerData: { appId: app, code },
    resourceLimits: { maxOldGenerationSizeMb: 256 },
    stdout: false,
    stderr: false,
  });

  const entry: AppEntry = {
    hash,
    worker,
    manifest: undefined,
    pending: new Map(),
    retiring: false,
  };

  // Only worker.mjs posts from a worker, and it posts FromWorker.
  worker.on("message", (message: FromWorker) => {
    fromWorker(app, entry, message);
  });
  worker.on("error", (cause: unknown) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));

    failPending(entry, `the app worker crashed: ${error.message}`);

    if (!entry.manifest) {
      toHost({
        t: "loadFailed",
        app,
        hash,
        error: error.stack ?? error.message,
      });
    }

    forget(app, entry);
  });
  worker.on("exit", () => {
    failPending(entry, "the app worker exited");
    forget(app, entry);
  });
}

function fromWorker(app: string, entry: AppEntry, message: FromWorker) {
  if (message.t === "ready") {
    entry.manifest = message.manifest;
    const previous = apps.get(app);

    apps.set(app, entry);

    if (previous && previous !== entry) {
      retire(previous);
    }

    toHost({
      t: "loaded",
      app,
      hash: entry.hash,
      manifest: message.manifest,
    });
  } else if (message.t === "failed") {
    terminate(entry.worker);
    toHost({ t: "loadFailed", app, hash: entry.hash, error: message.error });
  } else if (message.t === "result") {
    const reply = entry.pending.get(message.id);

    entry.pending.delete(message.id);
    reply?.(message);

    if (entry.retiring && entry.pending.size === 0) {
      terminate(entry.worker);
    }
  } else {
    forwardDb(app, entry.worker, message);
  }
}

function forwardDb(
  app: string,
  worker: Worker,
  message: Extract<FromWorker, { t: "db" }>
) {
  if (!host) {
    toWorker(worker, {
      t: "dbResult",
      id: message.id,
      ok: false,
      error: "the host is not connected",
    });

    return;
  }

  const id = nextDbId;

  nextDbId += 1;
  dbWaiting.set(id, { worker, id: message.id });
  toHost({ t: "db", id, app, request: message.request });
}

/** A replaced worker finishes the calls it has, then exits. */
function retire(entry: AppEntry) {
  entry.retiring = true;

  if (entry.pending.size === 0) {
    terminate(entry.worker);
  }
}

function terminate(worker: Worker) {
  worker.terminate().catch((cause: unknown) => {
    console.error(`agentd: a worker did not stop: ${String(cause)}`);
  });
}

function unload(app: string) {
  const entry = apps.get(app);

  apps.delete(app);

  if (entry) {
    retire(entry);
  }
}

function forget(app: string, entry: AppEntry) {
  if (apps.get(app) === entry) {
    apps.delete(app);
  }
}

function failPending(entry: AppEntry, error: string) {
  for (const reply of entry.pending.values()) {
    reply({ ok: false, error });
  }

  entry.pending.clear();
}

function call(message: Extract<ToAgentd, { t: "call" }>) {
  const entry = apps.get(message.app);

  const reply = (outcome: Outcome) => {
    toHost(
      outcome.ok
        ? { t: "result", id: message.id, ok: true, value: outcome.value }
        : { t: "result", id: message.id, ok: false, error: outcome.error }
    );
  };

  if (!entry) {
    reply({ ok: false, error: `app ${message.app} is not loaded` });

    return;
  }

  entry.pending.set(message.id, reply);
  toWorker(entry.worker, {
    t: "call",
    id: message.id,
    name: message.name,
    args: message.args,
  });
}

server.listen(port, process.env.AGENTD_HOST ?? "0.0.0.0", () => {
  console.log(`agentd listening on ${port}`);
});

egress.listen();

// The screen starts with the machine, so the agent's programs have a display before anyone opens it.
console.log(
  (await startScreen()) ? `screen on ${SCREEN_DISPLAY}` : "no screen"
);

// The egress proxy, the part of agentd the agent's commands send their HTTPS requests to (HTTPS_PROXY, on the
// machine's loopback). A request to a host one of the owner's secrets is for goes to the host, which puts the secret
// on it: the host keeps a control socket open, the proxy asks it over that socket to open a stream socket for each
// tunnel, and passes the tunnel's bytes through as they came, CONNECT line included. The host answers the CONNECT
// itself. Every other request goes out from here directly, as it would without the proxy. The rule list holds host
// names only; values never come to the machine.
//
// The host strips this file's types and installs it beside agentd.mjs (src/machine-runtime.ts). Import only types,
// Node's own modules and ws.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import path from "node:path";
import { createWebSocketStream, type RawData, WebSocket } from "ws";
import type { FromEgress, ToEgress } from "../src/protocol.ts";

export type EgressProxyOptions = {
  /** Where the proxy listens, on the machine's loopback. */
  readonly port: number;
  /** Where the CA certificate and the bundle with it are kept (see egressEnv in src/machine-runtime.ts). */
  readonly dir: string;
};

/** A request for a secret's host, held until the host opens its stream socket. */
type Tunnel = {
  readonly socket: Socket;
  /** What the client sent so far: its CONNECT request. */
  readonly head: Buffer;
  readonly timer: NodeJS.Timeout;
};

/** Where a CONNECT request wants to go. The port stays as the client wrote it. */
type Target = { readonly hostname: string; readonly port: string };

const SYSTEM_BUNDLES = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/cert.pem",
];

const MAX_HEAD_BYTES = 16_384;

export function egressProxy({ port, dir }: EgressProxyOptions) {
  const control = hostControl((pem) => {
    writeCa(dir, pem);
  });

  /** Stream id -> the request waiting for the host to open that stream. */
  const tunnels = new Map<string, Tunnel>();

  const viaHost = async (socket: Socket, head: Buffer) => {
    const host = await control.within(10_000);

    if (!host) {
      refuse(
        socket,
        "502 Bad Gateway",
        "Imp's host is not connected to this computer, so it cannot add your secret. Try again in a moment.\n"
      );

      return;
    }

    const id = randomUUID();

    const timer = setTimeout(() => {
      if (tunnels.delete(id)) {
        refuse(
          socket,
          "504 Gateway Timeout",
          "Imp's host did not open the tunnel.\n"
        );
      }
    }, 15_000);

    tunnels.set(id, { socket, head, timer });
    socket.on("close", () => {
      if (tunnels.delete(id)) {
        clearTimeout(timer);
      }
    });
    host.send(JSON.stringify({ t: "open", id } satisfies FromEgress));
  };

  /** The host opened the stream socket for tunnel `id`: the client's bytes go through it, CONNECT request first. */
  const joinTunnel = (ws: WebSocket, id: string) => {
    const tunnel = tunnels.get(id);

    tunnels.delete(id);

    if (!tunnel) {
      ws.close(1008, "no such tunnel");

      return;
    }

    clearTimeout(tunnel.timer);
    const duplex = createWebSocketStream(ws);

    duplex.on("error", () => {
      tunnel.socket.destroy();
    });
    tunnel.socket.on("error", () => {
      duplex.destroy();
    });
    duplex.write(tunnel.head);
    tunnel.socket.pipe(duplex).pipe(tunnel.socket);
    tunnel.socket.resume();
  };

  const server = createServer((socket) => {
    readHead(socket, (head, end) => {
      const target = connectTarget(head);

      if (!target) {
        refuse(
          socket,
          "405 Method Not Allowed",
          "Imp's proxy only carries HTTPS (CONNECT).\n"
        );
      } else if (control.handles(target.hostname) && target.port === "443") {
        viaHost(socket, head).catch((cause: unknown) => {
          console.error(`egress proxy: ${String(cause)}`);
          socket.destroy();
        });
      } else {
        direct(socket, target, head.subarray(end + 4));
      }
    });
  });

  server.on("error", (error) => {
    console.error(`egress proxy: ${error.message}`);
  });

  return {
    /** A socket from the host: its control socket, or with `stream` the socket for that tunnel. */
    serve: (ws: WebSocket, stream: string | null) => {
      if (stream) {
        joinTunnel(ws, stream);
      } else {
        control.accept(ws);
      }
    },
    /** Starts taking the commands' requests. Only the machine's own programs may use the proxy. */
    listen: () => {
      server.listen(port, "127.0.0.1", () => {
        console.log(`egress proxy on 127.0.0.1:${port}`);
      });
    },
  };
}

/** The host's control socket: the newest one, the host names it sent, and the requests waiting for it. */
function hostControl(writeCa: (pem: string) => void) {
  let current: WebSocket | undefined;
  /** The host names whose requests go to the host. */
  let hosts = new Set<string>();
  /** Waiting for the host's control socket: called with it. */
  let waiters: ((ws: WebSocket) => void)[] = [];

  const configure = (ws: WebSocket, message: ToEgress) => {
    hosts = new Set(message.hosts.map((host) => host.toLowerCase()));

    if (message.ca) {
      writeCa(message.ca);
    }

    ws.send(JSON.stringify({ t: "configured" } satisfies FromEgress));

    for (const resolve of waiters.splice(0)) {
      resolve(ws);
    }
  };

  return {
    /** Whether requests to `hostname` go to the host. */
    handles: (hostname: string) => hosts.has(hostname.toLowerCase()),
    accept: (ws: WebSocket) => {
      current?.close(4000, "replaced by a newer host connection");
      current = ws;
      ws.on("message", (data) => {
        // SAFETY: only the host holds the token, and it sends ToEgress (src/egress.ts).
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse is typed `any`.
        configure(ws, JSON.parse(text(data)) as ToEgress);
      });
      ws.on("close", () => {
        if (current === ws) {
          current = undefined;
        }
      });
    },
    /** The control socket: the open one, else the next one once it sent its rules; undefined after `ms` without one. */
    within: async (ms: number) => {
      if (current?.readyState === WebSocket.OPEN) {
        return current;
      }

      return await new Promise<WebSocket | undefined>((resolve) => {
        const done = (ws: WebSocket) => {
          clearTimeout(timer);
          resolve(ws);
        };

        const timer = setTimeout(() => {
          waiters = waiters.filter((waiter) => waiter !== done);
          resolve(undefined);
        }, ms);

        waiters.push(done);
      });
    },
  };
}

const text = (data: RawData) => {
  if (Buffer.isBuffer(data)) {
    return data.toString("utf-8");
  }

  return (
    Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
  ).toString("utf-8");
};

/** The CA certificate, and a bundle of the system's CAs with it, for the commands' environment (see egressEnv). */
function writeCa(dir: string, pem: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const caFile = path.join(dir, "egress-ca.pem");
  const bundleFile = path.join(dir, "ca-bundle.pem");
  const system = SYSTEM_BUNDLES.find((file) => existsSync(file));

  const systemCas = system
    ? `${readFileSync(system, "utf-8").trimEnd()}\n`
    : "";

  const bundle = `${systemCas}${pem.trim()}\n`;

  const current = existsSync(bundleFile)
    ? readFileSync(bundleFile, "utf-8")
    : "";

  writeFileSync(caFile, `${pem.trim()}\n`);

  if (current !== bundle) {
    writeFileSync(bundleFile, bundle);
  }
}

/**
 * Collects what a client sends until its request's blank line, then pauses the socket and hands over everything read
 * and where the blank line starts. A request line that never ends is refused.
 */
function readHead(socket: Socket, ready: (head: Buffer, end: number) => void) {
  let head = Buffer.alloc(0);

  socket.on("error", () => {
    // The client went away: its other listeners close what they opened for it.
  });

  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");

    if (end === -1) {
      if (head.length > MAX_HEAD_BYTES) {
        refuse(socket, "431 Request Header Fields Too Large", "");
      }

      return;
    }

    socket.off("data", onData);
    socket.pause();
    ready(head, end);
  };

  socket.on("data", onData);
}

/** Where a request asks to be connected; undefined when it is not a CONNECT to a host and port. */
function connectTarget(head: Buffer): Target | undefined {
  const [method, target = ""] = head
    .subarray(0, head.indexOf("\r\n"))
    .toString("latin1")
    .split(" ");

  const [, hostname, port] = /^\[?([^\]]+?)\]?:(\d+)$/.exec(target) ?? [];

  return method === "CONNECT" && hostname !== undefined && port !== undefined
    ? { hostname, port }
    : undefined;
}

function refuse(socket: Socket, status: string, reason: string) {
  socket.end(
    `HTTP/1.1 ${status}\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(reason)}\r\nconnection: close\r\n\r\n${reason}`
  );
}

/** A request for any other host: connected from here, as it would be without the proxy. */
function direct(socket: Socket, { hostname, port }: Target, rest: Buffer) {
  const upstream = connect(Number(port), hostname);

  upstream.on("connect", () => {
    socket.write("HTTP/1.1 200 Connection established\r\n\r\n");

    if (rest.length > 0) {
      upstream.write(rest);
    }

    socket.pipe(upstream).pipe(socket);
    socket.resume();
  });
  upstream.on("error", (error) => {
    if (!socket.writableEnded) {
      refuse(
        socket,
        "502 Bad Gateway",
        `Could not reach ${hostname}:${port}: ${error.message}\n`
      );
    }

    socket.destroy();
  });
  socket.on("close", () => {
    upstream.destroy();
  });
}

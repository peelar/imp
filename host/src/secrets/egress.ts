// The egress proxy: how the agent uses the owner's secrets without holding them. Commands on the machine get a
// stand-in and send their HTTPS requests to agentd's proxy there (computer/runtime.ts, egressEnv). agentd sends the
// requests for a secret's hosts to the host, over a stream socket the host opens to it (the machine cannot reach the
// host, but the host reaches every machine); the host passes each stream to mitmproxy on its loopback
// (egress-proxy.ts). mitmproxy ends TLS with Imp's own CA, which agentd adds to the machine's CA bundle, and its addon
// (egress/inject.py) puts the secret on the request and takes it out of the response. The host records each use.
//
// agentd's proxy takes a request only with the proxy password, which the host puts in the commands' proxy variables
// and sends the proxy as a hash. The app workers run in agentd's process and get neither, so app code cannot ride on the
// owner's secrets, or on the proxy at all.
//
// This file owns the host's sockets to the machine: the control socket, and one stream socket per tunnel.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createWebSocketStream, type RawData, WebSocket } from "ws";
import { type EgressRules, type EgressUse, mitmProxy } from "./egress-proxy.ts";
import type { Endpoint, Machine } from "../machine/machine.ts";
import {
  type FromEgress,
  fromEgressCheck,
  type ToEgress,
} from "./egress-protocol.ts";
import type { Vault } from "./vault.ts";

export type EgressOptions = {
  readonly dataDir: string;
  readonly toolsDir: string;
  readonly vault: Vault;
  readonly onUse: (use: EgressUse) => void;
};

/** The control socket to a machine's agentd. `configured` says whether agentd got the rules before the socket closed. */
type Control = {
  readonly machine: Machine;
  readonly ws: WebSocket;
  readonly configured: Promise<boolean>;
};

const why = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

const bytes = (frame: RawData) => {
  if (Buffer.isBuffer(frame)) {
    return frame;
  }

  return Array.isArray(frame) ? Buffer.concat(frame) : Buffer.from(frame);
};

function parse(frame: RawData): FromEgress | undefined {
  try {
    const message: unknown = JSON.parse(bytes(frame).toString("utf-8"));

    return fromEgressCheck.check(message) ? message : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The password agentd's proxy takes requests with. It is kept in DATA_DIR/egress, so the commands a host started
 * before it restarted can still use the proxy.
 */
function proxyPassword(dir: string) {
  const file = path.join(dir, "proxy-password");
  const kept = existsSync(file) ? readFileSync(file, "utf-8").trim() : "";

  if (/^[0-9a-f]{64}$/.test(kept)) {
    return kept;
  }

  const made = randomBytes(32).toString("hex");

  writeFileSync(file, made, { mode: 0o600 });

  return made;
}

/** A proxy URL such as http://127.0.0.1:7071 with the proxy password in it, which clients send on every CONNECT. */
const withPassword = (proxy: string, password: string) =>
  proxy.replace("://", `://imp:${password}@`);

export function openEgress(options: EgressOptions) {
  const dir = path.join(options.dataDir, "egress");

  const proxy = mitmProxy({
    dir,
    toolsDir: options.toolsDir,
    vault: options.vault,
    onUse: options.onUse,
  });

  // mitmProxy made the folder.
  const password = proxyPassword(dir);
  const passwordHash = createHash("sha256").update(password).digest("hex");

  /** The control socket to the current machine's agentd. */
  let control: Control | undefined;

  const config = () =>
    JSON.stringify({
      t: "config",
      hosts: proxy.hosts(),
      ca: proxy.caCertificate(),
      passwordHash,
    } satisfies ToEgress);

  /** A tunnel agentd asked for: a stream socket to it, piped into mitmproxy. */
  const openStream = async (socket: Endpoint, id: string) => {
    const { port } = await proxy.running();

    const ws = new WebSocket(`${socket.url}&stream=${encodeURIComponent(id)}`, {
      headers: { ...socket.headers },
    });

    const stream = createWebSocketStream(ws);
    const upstream = connect(port, "127.0.0.1");

    stream.on("error", () => {
      upstream.destroy();
    });
    upstream.on("error", () => {
      stream.destroy();
    });
    stream.pipe(upstream).pipe(stream);
  };

  /** Opens the control socket to `machine`'s agentd, replacing one to another machine, and sends it the rules. */
  const connectTo = async (machine: Machine) => {
    const { socket } = await machine.egress();

    await proxy.running();
    const ws = new WebSocket(socket.url, { headers: { ...socket.headers } });
    const configured = Promise.withResolvers<boolean>();
    const current: Control = { machine, ws, configured: configured.promise };

    control?.ws.close();
    control = current;
    ws.on("open", () => {
      ws.send(config());
    });
    ws.on("message", (data) => {
      const message = parse(data);

      if (message?.t === "configured") {
        configured.resolve(true);
      } else if (message?.t === "open" && message.id) {
        openStream(socket, message.id).catch((cause: unknown) => {
          console.error(`egress stream: ${why(cause)}`);
        });
      }
    });
    ws.on("error", (error) => {
      console.error(`egress control: ${error.message}`);
    });
    ws.on("close", () => {
      if (control === current) {
        control = undefined;
      }

      configured.resolve(false);
    });

    return current;
  };

  return {
    /**
     * The control socket to `machine` is open and agentd has the current rules, so a command started now has its
     * requests to a secret's hosts reach the host. Waits at most 20 seconds.
     */
    connect: async (machine: Machine) => {
      const current =
        control?.machine === machine && control.ws.readyState <= WebSocket.OPEN
          ? control
          : await connectTo(machine);

      await Promise.race([current.configured, sleep(20_000)]);
    },
    /** New rules: the addon reads them at once, and the machine connected now learns its hosts. */
    setRules: (next: EgressRules) => {
      proxy.setRules(next);

      if (control?.ws.readyState === WebSocket.OPEN) {
        control.ws.send(config());
      }
    },
    /** A command's environment for the machine's proxy, its proxy variables given the proxy password. */
    commandEnv: (env: Readonly<Record<string, string>>) =>
      Object.fromEntries(
        Object.entries(env).map(([name, value]) => [
          name,
          /^https?_proxy$/i.test(name) ? withPassword(value, password) : value,
        ])
      ),
    /** The agent moved to another machine: drop the control socket; the next command opens one there. */
    disconnect: () => {
      control?.ws.close();
      control = undefined;
    },
    close: () => {
      control?.ws.close();
      proxy.close();
    },
  };
}

export type Egress = ReturnType<typeof openEgress>;

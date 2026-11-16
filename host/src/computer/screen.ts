// The computer's screen: /computer/screen serves a noVNC page (screen.html), which the shell's Computer tab embeds
// (`?embed`) and which also opens in a tab of its own. Its WebSocket, /api/computer/screen, is bridged to the current machine's screen (`Machine.screen()`). Only the owner's pages reach
// it: the host checks the Tailscale login as for every request, and the page's origin, so another site the owner has
// open cannot connect.
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import type { Computer } from "./computer.ts";

const PAGE = path.join(import.meta.dirname, "screen.html");

const NOVNC = path.dirname(
  path.dirname(fileURLToPath(import.meta.resolve("@novnc/novnc")))
);

const SOCKET_PATH = "/api/computer/screen";
const KEEP_ALIVE_MS = 30_000;

/** A request to upgrade to a WebSocket. */
export type ScreenUpgrade = {
  readonly req: IncomingMessage;
  readonly socket: Duplex;
  readonly head: Buffer;
  /** Whether the request comes from the owner. */
  readonly allowed: boolean;
  /** The address the host was reached at, which the page that connects must have come from. */
  readonly origin: string;
};

export type ScreenSockets = ReturnType<typeof screenSockets>;

/** Serves the page at /computer/screen and noVNC's modules under /computer/novnc/; false for any other path. */
export function serveScreenPage(
  pathname: string,
  res: ServerResponse
): boolean {
  if (pathname === "/computer/screen" || pathname === "/computer/screen/") {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    });
    res.end(readFileSync(PAGE));

    return true;
  }

  if (!pathname.startsWith("/computer/novnc/")) {
    return false;
  }

  const file = path.normalize(
    path.join(
      NOVNC,
      decodeURIComponent(pathname.slice("/computer/novnc/".length))
    )
  );

  if (!file.startsWith(NOVNC + path.sep) || path.extname(file) !== ".js") {
    return false;
  }

  try {
    const body = readFileSync(file);

    res.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    });
    res.end(body);

    return true;
  } catch {
    return false;
  }
}

export function screenSockets(computer: Computer) {
  const server = new WebSocketServer({ noServer: true });
  const open = new Set<WebSocket>();

  // The screen belongs to the machine it opened on; a switch ends it, and the page connects to the new one.
  computer.onSwitch(() => {
    for (const client of open) {
      client.close(1012, "Your imp moved to another computer.");
    }
  });

  /** Joins the page's socket to the machine's screen, in both directions, until either side closes. */
  function bridge(client: WebSocket) {
    open.add(client);

    let upstream: WebSocket | undefined;
    /** What the page sent before the machine's screen answered. */
    const queued: RawData[] = [];

    const end = (code: number, reason: string) => {
      if (client.readyState === WebSocket.OPEN) {
        client.close(code, reason.slice(0, 120));
      }
    };

    const connect = async () => {
      const endpoint = await (await computer.machine()).screen();

      if (client.readyState !== WebSocket.OPEN) {
        return;
      }

      const screen = new WebSocket(endpoint.url, { headers: endpoint.headers });

      upstream = screen;
      screen.on("open", () => {
        for (const data of queued.splice(0)) {
          screen.send(data);
        }
      });
      screen.on("message", (data: RawData) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data);
        }
      });
      screen.on("close", (code, reason) => {
        end(code === 1011 ? 1011 : 1000, reason.toString("utf-8"));
      });
      screen.on("error", (error) => {
        end(1011, `The screen connection failed: ${error.message}`);
      });
    };

    client.on("message", (data: RawData) => {
      if (upstream?.readyState === WebSocket.OPEN) {
        upstream.send(data);
      } else {
        queued.push(data);
      }
    });
    // Someone watching keeps the machine awake.
    computer.touch();

    const awake = setInterval(() => {
      computer.touch();
    }, KEEP_ALIVE_MS);

    client.on("close", () => {
      open.delete(client);
      clearInterval(awake);
      upstream?.close();
    });
    connect().catch((cause: unknown) => {
      end(1011, cause instanceof Error ? cause.message : String(cause));
    });
  }

  return {
    /** Takes the upgrade when it is the screen's socket from the owner's page; false otherwise. */
    upgrade({ req, socket, head, allowed, origin }: ScreenUpgrade): boolean {
      if (new URL(req.url ?? "/", "http://host").pathname !== SOCKET_PATH) {
        return false;
      }

      if (!allowed || req.headers.origin !== origin) {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");

        return true;
      }

      server.handleUpgrade(req, socket, head, bridge);

      return true;
    },
    close() {
      for (const client of open) {
        client.terminate();
      }

      server.close();
    },
  };
}

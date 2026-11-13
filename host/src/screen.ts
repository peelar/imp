// The computer's screen in a browser tab: /computer serves a noVNC page (screen.html), and its WebSocket,
// /api/computer/screen, is bridged to the current machine's screen (`Machine.screen()`). Only the owner's pages reach
// it: the host checks the Tailscale login as for every request, and the page's origin, so another site the owner has
// open cannot connect.
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import type { Computer } from "./computer.ts";

const PAGE = join(import.meta.dirname, "screen.html");

const NOVNC = dirname(
  dirname(fileURLToPath(import.meta.resolve("@novnc/novnc")))
);

export const SOCKET_PATH = "/api/computer/screen";
const KEEP_ALIVE_MS = 30_000;

/** Serves the page at /computer and noVNC's modules under /computer/novnc/; false for any other path. */
export function serveScreenPage(
  pathname: string,
  res: ServerResponse
): boolean {
  if (pathname === "/computer" || pathname === "/computer/") {
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

  const path = normalize(
    join(NOVNC, decodeURIComponent(pathname.slice("/computer/novnc/".length)))
  );

  if (!path.startsWith(NOVNC + sep) || extname(path) !== ".js") {
    return false;
  }

  try {
    const body = readFileSync(path);
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

  function bridge(client: WebSocket) {
    open.add(client);
    let upstream: WebSocket | undefined;
    const queued: Buffer[] = [];

    const end = (code: number, reason: string) =>
      client.readyState === WebSocket.OPEN &&
      client.close(code, reason.slice(0, 120));

    client.on("message", (data: Buffer) =>
      upstream?.readyState === WebSocket.OPEN
        ? upstream.send(data)
        : queued.push(data)
    );
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
    computer
      .machine()
      .then(async (machine) => await machine.screen())
      .then(
        (endpoint) => {
          if (client.readyState !== WebSocket.OPEN) {
            return;
          }

          upstream = new WebSocket(endpoint.url, { headers: endpoint.headers });
          upstream.on("open", () => {
            for (const data of queued.splice(0)) {
              upstream!.send(data);
            }
          });
          upstream.on(
            "message",
            (data: Buffer) =>
              client.readyState === WebSocket.OPEN && client.send(data)
          );
          upstream.on("close", (code, reason) =>
            end(code === 1011 ? 1011 : 1000, String(reason))
          );
          upstream.on("error", (error) =>
            end(1011, `The screen connection failed: ${error.message}`)
          );
        },
        (error: unknown) =>
          end(1011, error instanceof Error ? error.message : String(error))
      );
  }

  return {
    /** Takes the upgrade when it is the screen's socket from the owner's page; false otherwise. */
    upgrade(
      req: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      allowed: boolean,
      origin: string
    ): boolean {
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

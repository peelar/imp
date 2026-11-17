// The host's one HTTP origin, on localhost only: the shell's API (/api/live/<source> streams an answer,
// /api/call/<name> makes a change), the MCP server other assistants use the owner's apps through (/mcp), the page an
// MCP server's sign-in comes back to (/api/connections/callback), a few files of the host's own, the computer's screen,
// and the built web client.
// `tailscale serve` is the gate in front of it and tells it who signed in.
import { once } from "node:events";
import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { text } from "node:stream/consumers";
import { isJsonValue } from "@earendil-works/chord/json";
import type { Json } from "../../sdk/app.ts";
import { type Answer, serveLive, type Topics } from "./live/live.ts";
import { type ScreenSockets, serveScreenPage } from "./computer/computer.ts";
import type { ShellApi } from "./shell-api.ts";
import { clientFile } from "./static.ts";

export type HttpOptions = {
  readonly port: number;
  /** The Tailscale login allowed in. Absent: everyone on the tailnet. */
  readonly owner: string | undefined;
  readonly api: ShellApi;
  /** Answers a request to /mcp, given the address the host was reached at (assistants/assistants.ts). */
  readonly mcp: (
    req: IncomingMessage,
    res: ServerResponse,
    origin: string
  ) => Promise<void>;
  readonly topics: Topics;
  readonly screens: ScreenSockets;
  /** The built web client to serve now, if there is one: the host builds a new one when its apps change. */
  readonly clientDir: () => string | undefined;
  /** The running release's tag; "dev" in a checkout. */
  readonly version: string;
  /** The Mac installer script and the repository it downloads Imp.app from. */
  readonly macInstaller: string | undefined;
  readonly repo: string | undefined;
  /** An MCP server's sign-in page sent the person back with these parameters: what to tell them. */
  readonly connectionCallback: (
    params: URLSearchParams
  ) => Promise<{ readonly ok: boolean; readonly message: string }>;
};

type Request = {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
};

/** Sends JSON; nothing when there is no value. */
function send(res: ServerResponse, status: number, value?: Answer) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(value === undefined ? "" : JSON.stringify(value));
}

/** The shell's arguments: a JSON list, and an empty one for anything else. */
function argumentList(written: string): Json[] {
  const value: unknown = JSON.parse(written);

  return isJsonValue(value) && Array.isArray(value) ? value : [];
}

/** Whether the request comes from the owner. Tailscale Serve connects from localhost and adds who signed in. */
const fromOwner = (req: IncomingMessage, owner: string | undefined) =>
  !owner || req.headers["tailscale-user-login"] === owner;

/**
 * Without an owner set, the tailnet is the gate; with one, every other login is turned away. Loopback browsers in
 * development may also call from another port.
 */
function allowed({ req, res }: Request, owner: string | undefined): boolean {
  if (!fromOwner(req, owner)) {
    send(res, 403, { error: "This Imp belongs to someone else." });

    return false;
  }

  const { origin } = req.headers;

  if (origin && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("vary", "origin");
  }

  return true;
}

/**
 * The address the request reached the host at. It listens on localhost only, so a proxy in front of it (`tailscale
 * serve`) set the forwarded headers.
 */
function reachedAt(req: IncomingMessage, port: number): string {
  const forwarded = (name: string) => {
    const [first = ""] = [req.headers[name]].flat().join(",").split(",");

    return first.trim();
  };

  const proto = forwarded("x-forwarded-proto") || "http";

  const hostname =
    forwarded("x-forwarded-host") || (req.headers.host ?? `127.0.0.1:${port}`);

  return `${proto}://${hostname}`;
}

async function serveSource(options: HttpOptions, request: Request) {
  const { req, res, url } = request;
  const [, name = ""] = /^\/api\/live\/(\w+)$/.exec(url.pathname) ?? [];

  const source = options.api.live(
    name,
    argumentList(url.searchParams.get("args") ?? "[]")
  );

  if (source) {
    await serveLive({ req, res, topics: options.topics, source });
  } else {
    send(res, 404, { error: `no source ${name}` });
  }
}

async function serveCall(options: HttpOptions, { req, res, url }: Request) {
  const [, name = ""] = /^\/api\/call\/(\w+)$/.exec(url.pathname) ?? [];

  // JSON only: a cross-site form cannot send it without the browser asking first.
  if (!req.headers["content-type"]?.startsWith("application/json")) {
    send(res, 415, { error: "JSON only" });

    return;
  }

  const body = await text(req);
  const reply = await options.api.mutate(name, argumentList(body || "[]"));

  if (reply === undefined) {
    send(res, 404, { error: `no mutation ${name}` });
  } else {
    send(res, 200, reply);
  }
}

/** An image the person sent in a chat: /api/image/<conversation>/<entry>/<nth>. A sent message never changes. */
async function serveImage(options: HttpOptions, { res, url }: Request) {
  const [, conversation = "", entry = "", nth = ""] =
    /^\/api\/image\/(\d+)\/(\d+)\/(\d+)$/.exec(url.pathname) ?? [];

  const image = await options.api.image(
    conversation,
    Number(entry),
    Number(nth)
  );

  if (image) {
    res.writeHead(200, {
      "content-type": image.mimeType,
      "cache-control": "private, max-age=31536000, immutable",
    });
    res.end(Buffer.from(image.data, "base64"));
  } else {
    send(res, 404, { error: "no such image" });
  }
}

/** Serves the file a GET asks for; false when the host has none to offer. */
function serveFile(options: HttpOptions, { req, res, url }: Request): boolean {
  const { pathname } = url;

  // The address the browser reached the host at, for a web build that has none baked in (see client/app.ts).
  if (pathname === "/assets/host.json") {
    send(res, 200, { origin: reachedAt(req, options.port) });

    return true;
  }

  // `curl -fsSL https://<this host>/install-mac.sh | sh` installs the Mac app, already pointed at this host.
  if (pathname === "/install-mac.sh" && options.macInstaller) {
    const script = readFileSync(options.macInstaller, "utf-8")
      .replaceAll("__IMP_HOST__", reachedAt(req, options.port))
      .replaceAll("__IMP_REPO__", options.repo ?? "");

    res.writeHead(200, {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(script);

    return true;
  }

  // The computer's screen, which the shell's Computer tab embeds; /computer itself is the shell's.
  if (serveScreenPage(pathname, res)) {
    return true;
  }

  const dir = options.clientDir();

  if (!dir) {
    return false;
  }

  const file = clientFile({ dir, pathname, version: options.version });

  if (file.found) {
    res.writeHead(file.status, file.headers);
    res.end(file.body);
  } else {
    send(res, 404, { error: file.error });
  }

  return true;
}

async function serve(options: HttpOptions, request: Request) {
  const { req, res, url } = request;
  const { method } = req;

  if (!allowed(request, options.owner)) {
    return;
  }

  if (method === "OPTIONS") {
    send(res, 204);
  } else if (url.pathname === "/mcp") {
    await options.mcp(req, res, reachedAt(req, options.port));
  } else if (method === "GET" && /^\/api\/live\/\w+$/.test(url.pathname)) {
    await serveSource(options, request);
  } else if (method === "POST" && /^\/api\/call\/\w+$/.test(url.pathname)) {
    await serveCall(options, request);
  } else if (method === "GET" && url.pathname === "/api/connections/callback") {
    // Plain text, so nothing the server put in the address is ever read as a page.
    const { ok, message } = await options.connectionCallback(url.searchParams);

    res.writeHead(ok ? 200 : 400, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(message);
  } else if (
    method === "GET" &&
    /^\/api\/image\/\d+\/\d+\/\d+$/.test(url.pathname)
  ) {
    await serveImage(options, request);
  } else if (
    url.pathname.startsWith("/api/") ||
    method !== "GET" ||
    !serveFile(options, request)
  ) {
    send(res, 404, { error: "not found" });
  }
}

/** Starts the server and answers once it listens. */
export async function serveHttp(options: HttpOptions) {
  const { screens, port } = options;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://host");

    serve(options, { req, res, url }).catch((cause: unknown) => {
      console.error(cause);

      if (res.headersSent) {
        res.end();
      } else {
        send(res, 500, { error: String(cause) });
      }
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const taken = screens.upgrade({
      req,
      socket,
      head,
      allowed: fromOwner(req, options.owner),
      origin: reachedAt(req, port),
    });

    if (!taken) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    }
  });
  server.listen(port, "127.0.0.1");
  // Rejects when the port cannot be listened on.
  await once(server, "listening");

  return {
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

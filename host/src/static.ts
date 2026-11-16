// The built web client (`exact web-build --out dist`) as files to serve, by Exact's static-host rule: the file at the
// path; else, for a path a route in routes.json matches, shell.html, from which the client draws the route; else a
// 404, with shell.html as its body for a page (the client draws its notfound route) and none for a file.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { arr, bool, compile, map, obj, str } from "@earendil-works/pi-schema";
import { readKept } from "./datadir/datadir.ts";

const TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json"],
  [".wasm", "application/wasm"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
  [".webmanifest", "application/manifest+json"],
  [".plan", "application/octet-stream"],
  [".txt", "text/plain; charset=utf-8"],
]);

/** routes.json, which Exact writes: the build's routes in the plan's order, and its files named by their content (old name: new name). */
const routesJson = compile(
  obj(
    {
      routes: arr(obj({ pattern: str(), notfound: bool() }, { open: true })),
      files: map(str()),
    },
    // Exact writes the file and may add to it; the host reads only these.
    { open: true }
  )
);

export type ClientRequest = {
  /** The built client's folder. */
  readonly dir: string;
  readonly pathname: string;
  /** The running release's tag; "dev" in a checkout. */
  readonly version: string;
};

export type ClientFile =
  | {
      readonly found: true;
      /** 200, or 404 for shell.html at a path no route matches. */
      readonly status: number;
      readonly headers: {
        readonly "content-type": string;
        readonly "cache-control": string;
      };
      readonly body: Buffer | string;
    }
  | { readonly found: false; readonly error: string };

/** The client's file for a path, or why there is none. */
export function clientFile({
  dir,
  pathname,
  version,
}: ClientRequest): ClientFile {
  const root = path.normalize(dir);
  const asked = path.normalize(path.join(root, decodeURIComponent(pathname)));

  if (asked !== root && !asked.startsWith(root + path.sep)) {
    return { found: false, error: "not found" };
  }

  const shell = path.join(root, "shell.html");

  if (!existsSync(shell)) {
    return { found: false, error: "the web client is not built" };
  }

  const table = routeTable(root);
  const file = existing(asked);

  const routed = table.routes.some(
    (route) => !route.notfound && matches(route.pattern, pathname)
  );

  // A file the build lacks (a browser's /favicon.ico, an old script) is a plain 404; the not-found page is for readers.
  if (!file && !routed && /\.[A-Za-z0-9]+$/.test(pathname)) {
    return { found: false, error: "not found" };
  }

  const served = file ?? shell;
  const type = path.extname(served);
  const body = readFileSync(served);
  const named = new Set(Object.values(table.files));

  return {
    found: true,
    status: file || routed ? 200 : 404,
    headers: {
      "content-type": TYPES.get(type) ?? "application/octet-stream",
      // routes.json `files` names the files named by their content, which never change; the pages, app.plan and the
      // rest change with every publish, so the browser asks again each time and open clients get the new version.
      "cache-control": named.has(path.relative(root, served))
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    },
    body:
      type === ".html" && version !== "dev"
        ? withReload(body.toString("utf-8"), version)
        : body,
  };
}

/** The file at `asked`, or its index.html (a page rendered at build); none when neither is there. */
function existing(asked: string) {
  if (existsSync(asked) && !statSync(asked).isDirectory()) {
    return asked;
  }

  const index = path.join(asked, "index.html");

  return existsSync(index) ? index : undefined;
}

/** The build's routes.json; a build without one, or with a damaged one, has no routes and no content-named files. */
function routeTable(root: string) {
  return (
    readKept(path.join(root, "routes.json"), routesJson, (problem) => {
      console.error(`client: ${problem}`);
    }) ?? {
      routes: [],
      files: {},
    }
  );
}

/** Whether a route's pattern (`/apps`, `/thread/:id`) matches a path: segment by segment, a `:name` matching any one. */
function matches(pattern: string, pathname: string) {
  const want = pattern.split("/").filter(Boolean);
  const have = pathname.split("/").filter(Boolean);

  return (
    want.length === have.length &&
    want.every((part, i) => part.startsWith(":") || part === have[i])
  );
}

/**
 * A released host's pages reload themselves when the host they reach is another release: the version stream ends when
 * the host restarts into an update, the browser opens it again, and the new host answers with its own version.
 */
function withReload(html: string, version: string): string {
  const script = `<script>new EventSource("/api/live/version").onmessage = (e) => { if (JSON.parse(e.data).version !== ${JSON.stringify(version)}) location.reload(); };</script>`;

  return html.includes("</head>")
    ? html.replace("</head>", `${script}</head>`)
    : script + html;
}

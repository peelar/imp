// The built web client (`exact web-build --out dist`) as files to serve, by Exact's static-host rule: a file at the
// path, else shell.html, from which the client draws the route (or its notfound route).
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

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

  const file = existing(root, asked);

  if (!file) {
    return { found: false, error: "the web client is not built" };
  }

  const type = path.extname(file);
  const body = readFileSync(file);

  return {
    found: true,
    headers: {
      "content-type": TYPES.get(type) ?? "application/octet-stream",
      // Files named by their content (`fragment-Cxnx3vsw.js`) never change; app.js, app.plan and the pages change
      // with every publish, so the browser asks again each time and open clients get the new version.
      "cache-control": /-[A-Za-z0-9_]{8}\.[a-z]+$/.test(file)
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    },
    body:
      type === ".html" && version !== "dev"
        ? withReload(body.toString("utf-8"), version)
        : body,
  };
}

/** The file to serve for `asked`: itself, its index.html, or the shell; none when the client is not built. */
function existing(root: string, asked: string) {
  if (existsSync(asked) && !statSync(asked).isDirectory()) {
    return asked;
  }

  const index = path.join(asked, "index.html");
  const fallback = existsSync(index) ? index : path.join(root, "shell.html");

  return existsSync(fallback) ? fallback : undefined;
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

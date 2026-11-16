// The built web client as the host serves it, by Exact's static-host rule, on a build laid out as `exact web-build`
// writes one: shell.html, routes.json with the routes and the files named by their content, and those files.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { clientFile } from "../src/static.ts";

const dir = mkdtempSync(path.join(tmpdir(), "imp-static-"));

mkdirSync(path.join(dir, "assets"));

writeFileSync(
  path.join(dir, "shell.html"),
  "<html><head></head><body>shell</body></html>"
);

writeFileSync(path.join(dir, "app-CMsBqlxb.js"), "app");

writeFileSync(path.join(dir, "app.plan"), "plan");

writeFileSync(path.join(dir, "assets", "font.ttf"), "font");

writeFileSync(
  path.join(dir, "routes.json"),
  JSON.stringify({
    routes: [
      { name: "chat", pattern: "/", render: "client", notfound: false },
      {
        name: "thread",
        pattern: "/thread/:id",
        render: "client",
        notfound: false,
      },
      { name: "notfound", pattern: "", render: "client", notfound: true },
    ],
    files: { "app.js": "app-CMsBqlxb.js" },
  })
);

const answer = (pathname: string) => {
  const file = clientFile({ dir, pathname, version: "dev" });

  return file.found
    ? [file.status, file.headers["cache-control"], String(file.body)]
    : [404, file.error];
};

test("a route's path is the shell; a path no route matches is the shell with 404; a missing file is a plain 404", () => {
  assert.deepEqual(answer("/"), [
    200,
    "no-cache",
    "<html><head></head><body>shell</body></html>",
  ]);
  assert.deepEqual(answer("/thread/42"), [
    200,
    "no-cache",
    "<html><head></head><body>shell</body></html>",
  ]);
  assert.deepEqual(answer("/thread/42/more"), [
    404,
    "no-cache",
    "<html><head></head><body>shell</body></html>",
  ]);
  assert.deepEqual(answer("/favicon.ico"), [404, "not found"]);
  assert.deepEqual(answer("/../etc/passwd"), [404, "not found"]);
});

test("only the files routes.json names by their content are kept for good", () => {
  assert.deepEqual(answer("/app-CMsBqlxb.js"), [
    200,
    "public, max-age=31536000, immutable",
    "app",
  ]);
  assert.deepEqual(answer("/app.plan"), [200, "no-cache", "plan"]);
  // A name shaped like a hash is not enough: a font the app ships under its own name changes with the app.
  assert.deepEqual(answer("/assets/font.ttf"), [200, "no-cache", "font"]);
});

test("a host with no build says so", () => {
  const empty = mkdtempSync(path.join(tmpdir(), "imp-static-"));

  assert.deepEqual(clientFile({ dir: empty, pathname: "/", version: "dev" }), {
    found: false,
    error: "the web client is not built",
  });
});

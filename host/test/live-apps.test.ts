// Live apps, through the host's HTTP API: an app that names its connections and has a sync. The host syncs its live
// version when its tab reads it and on Sync now, never its draft; it keeps the sync's status and says what a version
// reads; and it holds every app.fetch to the app's connections, to reads, and away from the host's own network.
// The apps are written into the host's data directory before it starts, as the studio keeps saved code and drafts.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Json } from "../../sdk/app.ts";
import { checkFetch, isInternal } from "../src/apps/connections.ts";
import {
  call,
  dataDir,
  done,
  first,
  isRow,
  refused,
  rows,
  startTestHost,
  stopTestHost,
  until,
} from "./harness.ts";

/** A server.ts whose sync records each run, and fetches from its connection once `failing` has a row. */
const reader = (host: string) => `export default {
  schema: ["CREATE TABLE runs (at INTEGER)", "CREATE TABLE failing (on_ INTEGER)"],
  connections: [{ host: "${host}", secret: "example", query: "/graphql" }],
  sync: {
    every: "15m",
    run: async (app) => {
      await app.db.run("INSERT INTO runs (at) VALUES (?)", Date.now());
      if (await app.db.get("SELECT 1 AS yes FROM failing")) await app.fetch("https://${host}/items");
    },
  },
  operations: {
    runs: { kind: "read", description: "How many syncs ran.", params: {},
      run: async (_args, app) => (await app.db.get("SELECT count(*) AS n FROM runs")).n },
    fail: { kind: "write", description: "Make the next sync fetch.", params: {},
      run: async (_args, app) => { await app.db.run("INSERT INTO failing (on_) VALUES (1)"); return { ok: true, error: "" }; } },
    tryFetch: { kind: "write", description: "Fetch a URL with a method, and say why it was refused.",
      params: { url: { type: "string" }, method: { type: "string" } },
      run: async ({ url, method }, app) => {
        try { await app.fetch(url, { method }); return { ok: true, error: "" }; }
        catch (error) { return { ok: false, error: error.message }; }
      } },
  },
};`;

const contract = `component Screen
  view
    text "Reader"
`;

function writeApp(id: string, kind: "live" | "draft", server: string) {
  const dir = path.join(dataDir, "code", id, kind);

  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "app.json"),
    JSON.stringify({ id, name: id, description: "Reads a service." })
  );
  writeFileSync(path.join(dir, "app.contract"), contract);
  writeFileSync(path.join(dir, "server.ts"), server);
}

/** The app as the shell's list shows it, once `accept` takes it. */
const tile =
  (id: string, accept: (app: Record<string, Json>) => boolean = () => true) =>
  (answer: Json) =>
    rows(answer).find((app) => app.id === id && accept(app));

before(async () => {
  writeApp("reader", "live", reader("api.example.com"));
  // An app being previewed: the shell shows its draft, which reads another host and is never synced.
  writeApp("drafted", "live", reader("api.example.com"));
  writeApp("drafted", "draft", reader("api.example.org"));
  await startTestHost();
});

after(async () => {
  await stopTestHost();
});

test("opening a live app syncs it once, and the shell says when and what it reads", async () => {
  // Its tab reads it, which starts the sync; the read answers again once the sync wrote.
  await until("readerRuns", (answer) => (answer === 1 ? answer : undefined));

  const shown = await until(
    "apps",
    tile("reader", (app) => app.sync === "Synced just now")
  );

  assert.equal(
    shown?.reads,
    "Reads api.example.com with your example key, every 15 min."
  );
  // Not due again for 15 minutes: reading it again does not sync it.
  assert.equal(await first("readerRuns"), 1);
});

test("a draft is never synced, and the shell says what the draft reads", async () => {
  assert.equal(await first("draftedRuns"), 0);

  const shown = await until("apps", tile("drafted"));

  assert.equal(
    shown?.reads,
    "Reads api.example.org with your example key, every 15 min."
  );
  assert.equal(await first("draftedRuns"), 0);
});

test("Sync now runs it again, and a failed sync says why on the app's bar", async () => {
  assert.deepEqual(await call("readerFail", []), done);

  const needs = "needs secret example: add it in Settings → Secrets.";

  assert.deepEqual(await call("appsSync", ["reader"]), refused(needs));
  assert.equal(await first("readerRuns"), 2);
  await until(
    "apps",
    tile("reader", (app) => app.sync === `Sync failing: ${needs}`)
  );
  assert.deepEqual(
    await call("appsSync", ["todos"]),
    refused("The todos app has no sync.")
  );
});

test("app.fetch reaches only the app's connections, over HTTPS, and only reads", async () => {
  const tries = await Promise.all(
    [
      ["https://api.github.com/user", "GET"],
      ["http://api.example.com/items", "GET"],
      ["https://api.example.com:8443/items", "GET"],
      ["https://api.example.com/items", "DELETE"],
      ["https://api.example.com/items", "POST"],
      ["https://api.example.com/graphql", "POST"],
    ].map(async (args) => await call("readerTryFetch", args))
  );

  const errors = tries.map(({ body }) => (isRow(body) ? body.error : ""));

  assert.deepEqual(errors, [
    "The reader app does not list api.github.com in its connections, so app.fetch refuses it.",
    "app.fetch reaches HTTPS on port 443 only, not http://api.example.com.",
    "app.fetch reaches HTTPS on port 443 only, not https://api.example.com:8443.",
    "Apps only read: app.fetch takes GET and HEAD, and POST only to a connection's query path (/graphql on api.example.com), not DELETE /items.",
    "Apps only read: app.fetch takes GET and HEAD, and POST only to a connection's query path (/graphql on api.example.com), not POST /items.",
    // A read by POST to the query path passes the rules, and then needs the key.
    "needs secret example: add it in Settings → Secrets.",
  ]);
});

test("app.fetch refuses a host that resolves to the host's own network", async () => {
  const rules = (addresses: string[]) => ({
    app: "reader",
    connections: [{ host: "api.example.com" }],
    keyHosts: () => [],
    resolve: async () => addresses,
  });

  const request = {
    op: "fetch" as const,
    url: "https://api.example.com/items",
    method: "GET",
    headers: {},
    body: "",
  };

  const internal = [
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.100.1.1",
    "0.0.0.0",
    "::1",
    "fd7a:115c:a1e0::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ];

  assert.deepEqual(
    internal.filter((address) => !isInternal(address)),
    []
  );
  // One internal address among the answers is enough to refuse.
  await Promise.all(
    internal.map(async (address) => {
      await assert.rejects(
        checkFetch(rules(["93.184.215.14", address]), request),
        /resolves to an address on the host's own network/
      );
    })
  );

  for (const external of ["93.184.215.14", "172.32.0.1", "2606:4700::1"]) {
    assert.ok(!isInternal(external), external);
  }

  assert.equal(
    (await checkFetch(rules(["93.184.215.14"]), request)).address,
    "93.184.215.14"
  );
});

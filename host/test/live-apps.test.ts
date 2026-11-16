// Live apps, through the host's HTTP API: an app that names its connections and has a sync. The host syncs its live
// version when its tab reads it and on Sync now, never its draft, and waits without failing for a key it lacks; it keeps the sync's status and says what a version
// reads; and it holds every app.fetch to the app's connections, to reads, and away from the host's own network.
// The apps are written into the host's data directory before it starts, as the studio keeps saved code and drafts.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Json } from "../../sdk/app.ts";
import { checkFetch, isInternal } from "../src/apps/connections.ts";
import { appWatch } from "../src/apps/watch.ts";
import { impServers, storedApps } from "../src/studio/code.ts";
import { requireImpServer } from "../src/studio/preview.ts";
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

test("an app waits for a key it lacks without failing, and syncs once the owner adds it", async () => {
  // Its tab reads it, which loads it on the computer: what it needs is known from then on, and it does not sync.
  assert.equal(await first("readerRuns"), 0);

  // Waiting is no failure: the bar says nothing of the sync, and the shell hears which key the app waits for.
  const waiting = await until(
    "apps",
    tile("reader", (app) => app.needs === "example")
  );

  assert.equal(waiting?.sync, "");
  assert.deepEqual(
    await call("appsSync", ["reader"]),
    refused("The reader app waits for a key you have not added yet.")
  );

  // A key for another host, so the app's own fetches still fail below, the same way every time.
  assert.deepEqual(
    await call("secretsPut", [
      "example",
      "other",
      "key",
      "other.example.net",
      "",
      "",
      "",
    ]),
    done
  );
  await until("readerRuns", (answer) => (answer === 1 ? answer : undefined));

  const shown = await until(
    "apps",
    tile("reader", (app) => app.sync === "Synced just now")
  );

  assert.equal(shown?.needs, "");
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

  const why =
    "The example key is not for api.example.com: it goes on requests to other.example.net.";

  assert.deepEqual(await call("appsSync", ["reader"]), refused(why));
  assert.equal(await first("readerRuns"), 2);
  await until(
    "apps",
    tile("reader", (app) => app.sync === `Sync failing: ${why}`)
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
    // A read by POST to the query path passes the rules, and then needs the key to be for its host.
    "The example key is not for api.example.com: it goes on requests to other.example.net.",
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

test("a watched URL runs the sync when its answer changed, and not when nothing is new", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "imp-watch-"));
  const url = "https://api.example.com/notifications";
  const sent: Record<string, string>[] = [];
  const changed: string[] = [];
  let answer = { status: 200, headers: { etag: '"1"' }, body: "[1]" };

  /** A watcher as the host starts it, which asks once and lets the answer settle. */
  const askOnce = async () => {
    const watch = appWatch({
      dataDir: dir,
      // The live version watches the URL; a draft beside it is never asked.
      slots: () =>
        new Map([
          ["reader", { id: "reader" }],
          ["reader~draft", { id: "reader" }],
        ]),
      known: () => ({ manifest: { watch: [url] } }),
      ask: async (_slot, request) => {
        sent.push(request.headers);

        return answer;
      },
      changed: async (id) => {
        changed.push(id);

        return "";
      },
      log: () => {},
    });

    watch.tick();
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    watch.stop();
  };

  // The first answer is new.
  await askOnce();
  assert.deepEqual(changed, ["reader"]);

  // After a restart, the host asks with what it saw: nothing new, nothing runs.
  answer = { status: 304, headers: { etag: '"1"' }, body: "" };
  await askOnce();
  assert.deepEqual(sent.at(-1), { "if-none-match": '"1"' });
  assert.deepEqual(changed, ["reader"]);

  // A new ETag on the same body is not a change; another body is.
  answer = { status: 200, headers: { etag: '"2"' }, body: "[1]" };
  await askOnce();
  assert.deepEqual(changed, ["reader"]);
  answer = { status: 200, headers: { etag: '"3"' }, body: "[1,2]" };
  await askOnce();
  assert.deepEqual(changed, ["reader", "reader"]);
  assert.equal(sent.length, 4);
});

test("an app Imp ships keeps Imp's server code under the person's screen", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "imp-repo-"));
  const data = mkdtempSync(path.join(tmpdir(), "imp-data-"));

  const files = (server: string, screen: string) => ({
    "app.json": JSON.stringify({ id: "hub", name: "Hub", server: "imp" }),
    "app.contract": screen,
    "server.ts": server,
  });

  const ours = files(reader("api.example.com"), contract);

  for (const [dir, version] of [
    [path.join(repo, "hub"), ours],
    // A version the person saved before Imp's update changed the server code.
    [
      path.join(data, "code", "hub", "live"),
      files(
        "export default { operations: {} };",
        'component Screen\n  view\n    text "Mine"\n'
      ),
    ],
  ] as const) {
    mkdirSync(dir, { recursive: true });

    for (const [name, text] of Object.entries(version)) {
      writeFileSync(path.join(dir, name), text);
    }
  }

  const hub = storedApps({
    dataDir: data,
    repoAppsDir: repo,
    hasData: () => false,
    log: () => {},
  }).live.find(({ id }) => id === "hub");

  assert.equal(hub?.files["server.ts"], ours["server.ts"]);
  assert.match(hub?.files["app.contract"] ?? "", /Mine/);

  // A preview may change the screen, and nothing else.
  const imp = impServers(repo).get("hub");

  requireImpServer({ ...ours, "app.contract": "changed" }, imp);
  assert.throws(() => {
    requireImpServer({ ...ours, "server.ts": "changed" }, imp);
  }, /Put back server.ts as app_code wrote them/);
});

test("an app Imp ships runs once installed, or where it ran before apps had to be installed; an uninstalled one stays out", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "imp-repo-"));
  const data = mkdtempSync(path.join(tmpdir(), "imp-data-"));

  for (const [id, json] of [
    ["notes", { id: "notes", name: "Notes" }],
    ["hub", { id: "hub", name: "Hub", server: "imp" }],
  ] as const) {
    mkdirSync(path.join(repo, id));
    writeFileSync(path.join(repo, id, "app.json"), JSON.stringify(json));
    writeFileSync(path.join(repo, id, "app.contract"), contract);
    writeFileSync(
      path.join(repo, id, "server.ts"),
      "export default { operations: {} };"
    );
  }

  const live = (hasData: (id: string) => boolean) =>
    storedApps({ dataDir: data, repoAppsDir: repo, hasData, log: () => {} })
      .live.map(({ id }) => id)
      .sort();

  // A new host runs none of them.
  assert.deepEqual(
    live(() => false),
    []
  );
  assert.equal(existsSync(path.join(data, "code")), false);

  // A host that ran them before keeps them: Imp's own as the repository has it, any other as its own live version.
  assert.deepEqual(
    live(() => true),
    ["hub", "notes"]
  );
  assert.ok(existsSync(path.join(data, "code", "hub", "installed")));
  assert.ok(existsSync(path.join(data, "code", "notes", "live", "server.ts")));

  // Uninstalled, neither comes back, even with data left behind.
  for (const id of ["notes", "hub"]) {
    rmSync(path.join(data, "code", id), { recursive: true, force: true });
    mkdirSync(path.join(data, "code", id), { recursive: true });
    writeFileSync(path.join(data, "code", id, "uninstalled"), "");
  }

  assert.deepEqual(
    live(() => true),
    []
  );
});

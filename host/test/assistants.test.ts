// Other assistants, through the host's MCP server at /mcp: no app is theirs until the owner shares it in Settings →
// Assistants; then each of its operations the agent may run is a tool, with hints from its kind, and a call runs it
// the way the imp does, so the owner's open views update. Operations kept from the agent, and drafts, are never
// tools, and a client hears when the tools change. The apps are written into the host's data directory before it
// starts, as the studio keeps saved code and drafts.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { copyJson } from "@earendil-works/chord/json";
import type { Json } from "../../sdk/app.ts";
import {
  base,
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

const server = (extra: string) => `export default {
  schema: ["CREATE TABLE notes (text TEXT NOT NULL)"],
  operations: {
    count: { kind: "read", description: "How many notes there are.", params: {},
      run: async (_args, app) => (await app.db.get("SELECT count(*) AS n FROM notes")).n },
    add: { kind: "write", description: "Add a note.",
      params: { text: { type: "string", description: "What the note says." }, pinned: { type: "boolean", optional: true } },
      run: async ({ text }, app) => { await app.db.run("INSERT INTO notes (text) VALUES (?)", text); return { ok: true, error: "" }; } },
    wipe: { kind: "write", description: "Delete every note.", params: {}, agent: false,
      run: async (_args, app) => { await app.db.run("DELETE FROM notes"); return { ok: true, error: "" }; } },
    ${extra}
  },
};`;

function writeApp(id: string, kind: "live" | "draft", code: string) {
  const dir = path.join(dataDir, "code", id, kind);
  const name = id.charAt(0).toUpperCase() + id.slice(1);

  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "app.json"),
    JSON.stringify({ id, name, description: "Notes." })
  );
  writeFileSync(
    path.join(dir, "app.contract"),
    'component Screen\n  view\n    text "Notes"\n'
  );
  writeFileSync(path.join(dir, "server.ts"), code);
}

before(async () => {
  writeApp("notes", "live", server(""));
  // An app being previewed: its draft has an operation the saved app does not have yet.
  writeApp("drafted", "live", server(""));
  writeApp(
    "drafted",
    "draft",
    server(
      'later: { kind: "read", description: "Not saved yet.", params: {}, run: () => 1 },'
    )
  );
  await startTestHost();
});

after(async () => {
  await stopTestHost();
});

let next = 0;

/** Sends one JSON-RPC request to /mcp, as an MCP client does, and answers the HTTP status and the JSON-RPC answer. */
async function rpc(
  method: string,
  params: Json = {},
  headers: Record<string, string> = {}
) {
  next += 1;

  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: next, method, params }),
  });

  const body = copyJson(JSON.parse(await response.text()));

  return { status: response.status, body: isRow(body) ? body : {} };
}

/** A request's result; fails on an error. */
async function result(method: string, params: Json = {}) {
  const { status, body } = await rpc(method, params);

  assert.equal(status, 200);
  assert.equal(body.error, undefined, JSON.stringify(body.error));

  return isRow(body.result) ? body.result : {};
}

const toolNames = async () =>
  rows((await result("tools/list")).tools).map((tool) => tool.name);

/** Opens the stream a GET to /mcp answers, and resolves once it says the tools changed. */
async function listChanged(signal: AbortSignal) {
  const response = await fetch(`${base}/mcp`, {
    headers: { accept: "text/event-stream" },
    signal,
  });

  assert.equal(response.status, 200);
  assert.ok(response.body);

  const stream = response.body.pipeThrough(new TextDecoderStream());

  return async () => {
    let seen = "";

    for await (const chunk of stream) {
      seen += chunk;

      if (seen.includes("notifications/tools/list_changed")) {
        return;
      }
    }

    assert.fail("the stream ended before the tools changed");
  };
}

test("an MCP client starts with no tools, and agrees on a protocol version", async () => {
  const init = await result("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });

  assert.equal(init.protocolVersion, "2025-06-18");
  assert.deepEqual(init.capabilities, { tools: { listChanged: true } });

  // A version the server does not speak gets its newest.
  const newest = await result("initialize", { protocolVersion: "1999-01-01" });

  assert.equal(newest.protocolVersion, "2025-11-25");

  // The client's notice that it is ready needs no answer.
  const notice = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });

  assert.equal(notice.status, 202);

  // The app has loaded, and still nothing is shared.
  assert.equal(await first("notesCount"), 0);
  assert.deepEqual(await toolNames(), []);
});

test("a shared app's operations are tools with hints, and only those the agent may run", async () => {
  const controller = new AbortController();
  const changed = await listChanged(controller.signal);

  assert.deepEqual(await call("assistantsShare", ["notes", true]), done);
  await changed();
  controller.abort();

  const tools = rows((await result("tools/list")).tools);

  // Not `wipe`, which the app keeps from the agent.
  assert.deepEqual(tools, [
    {
      name: "notes_count",
      title: "Notes: count",
      description: "Notes: How many notes there are.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: "notes_add",
      title: "Notes: add",
      description: "Notes: Add a note.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "What the note says." },
          pinned: { type: "boolean" },
        },
        required: ["text"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
  ]);

  // A shared app with a draft offers its saved operations, never the draft's `later`.
  assert.deepEqual(await call("assistantsShare", ["drafted", true]), done);
  assert.deepEqual(
    new Set(await toolNames()),
    new Set(["notes_count", "notes_add", "drafted_count", "drafted_add"])
  );

  const account = await first("account");

  assert.ok(isRow(account));
  const shared = rows(account.assistants);

  assert.deepEqual(
    ["drafted", "notes"].map((id) => shared.find((app) => app.id === id)),
    [
      {
        id: "drafted",
        name: "Drafted",
        symbol: "symbol:icon.layers",
        shared: true,
      },
      {
        id: "notes",
        name: "Notes",
        symbol: "symbol:icon.layers",
        shared: true,
      },
    ]
  );
});

test("a tool call runs the operation in the saved app, and the owner's open view updates", async () => {
  // The owner's open view of the count, which hears the change the call makes.
  const seen = until("notesCount", (answer) =>
    answer === 1 ? answer : undefined
  );

  const added = await result("tools/call", {
    name: "notes_add",
    arguments: { text: "milk" },
  });

  assert.deepEqual(added, {
    content: [{ type: "text", text: '{"ok":true,"error":""}' }],
    isError: false,
  });
  assert.equal(await seen, 1);

  // Arguments the operation does not take are the tool's failure, which the model reads.
  const wrong = await result("tools/call", {
    name: "notes_add",
    arguments: { text: 3 },
  });

  assert.equal(wrong.isError, true);
  assert.match(JSON.stringify(wrong.content), /does not take/);

  // What is not a tool is unknown, whatever the app has.
  const names = ["notes_wipe", "drafted_later", "notes_nothing"];

  const answers = await Promise.all(
    names.map(async (name) => await rpc("tools/call", { name, arguments: {} }))
  );

  assert.deepEqual(
    answers.map(({ body }) => body.error),
    names.map((name) => ({ code: -32_602, message: `Unknown tool: ${name}` }))
  );

  assert.equal(await first("notesCount"), 1);
});

test("an app the owner stops sharing is no assistant's, and a page on another site is turned away", async () => {
  assert.deepEqual(
    await call("assistantsShare", ["nothing", true]),
    refused("There is no nothing app.")
  );
  assert.deepEqual(await call("assistantsShare", ["notes", false]), done);
  assert.deepEqual(await call("assistantsShare", ["drafted", false]), done);
  assert.deepEqual(await toolNames(), []);

  const { body } = await rpc("tools/call", {
    name: "notes_count",
    arguments: {},
  });

  assert.deepEqual(body.error, {
    code: -32_602,
    message: "Unknown tool: notes_count",
  });

  assert.deepEqual(await call("assistantsShare", ["notes", true]), done);

  const elsewhere = await rpc(
    "tools/list",
    {},
    { origin: "https://evil.example" }
  );

  assert.equal(elsewhere.status, 403);

  const unknown = await rpc(
    "tools/list",
    {},
    { "mcp-protocol-version": "1999-01-01" }
  );

  assert.equal(unknown.status, 400);
  assert.deepEqual(await toolNames(), ["notes_count", "notes_add"]);
});

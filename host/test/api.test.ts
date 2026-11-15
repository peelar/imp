// The host's HTTP API, as the client uses it: live streams, calls, sign-in, the Todos app and the agent operating it,
// and the studio: the agent's preview of an app it wrote, and the person's Save, Discard and Undo. harness.ts starts
// the host these tests talk to. Run: npm test
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import type { Json } from "../../sdk/app.ts";
import {
  base,
  call,
  dataDir,
  done,
  first,
  isRow,
  refused,
  repo,
  type Row,
  rows,
  said,
  settledChat,
  startTestHost,
  stopTestHost,
  toolRow,
  until,
  vaultReady,
} from "./harness.ts";

const todoTitles = (answer: Json) => rows(answer).map((todo) => todo.title);

/**
 * The account once it has this status: the sign-in's own fields, without the computer, the memory, the secrets and
 * the backup that ride on the same stream.
 */
const withStatus = (wanted: string) => (answer: Json) => {
  const { status, code, url, error, email, plan } = isRow(answer) ? answer : {};

  return status === wanted
    ? { status, code, url, error, email, plan }
    : undefined;
};

/** What the imp remembers, once `accept` takes its entries; it rides on the account stream. */
const remembered = (accept: (entries: Row[]) => boolean) => (answer: Json) => {
  const memory = isRow(answer) ? answer.memory : undefined;
  const entries = isRow(memory) ? rows(memory.entries) : undefined;

  return entries && accept(entries) ? entries : undefined;
};

before(async () => {
  // The first sign-in cannot reach ChatGPT (scripts/test-host.ts).
  process.env.TEST_SIGNIN_UNREACHABLE = "1";
  await startTestHost();
  await vaultReady();
});

after(async () => {
  await stopTestHost();
  rmSync(dataDir, { recursive: true, force: true });
});

test("a source or mutation nobody owns is not found, and a call must be JSON", async () => {
  assert.equal((await fetch(`${base}/api/live/nothing`)).status, 404);
  assert.equal((await fetch(`${base}/api/other`)).status, 404);
  assert.deepEqual(await call("nothing", []), {
    status: 404,
    body: { error: "no mutation nothing" },
  });

  const form = await fetch(`${base}/api/call/chatStop`, {
    method: "POST",
    body: "a=1",
  });

  assert.equal(form.status, 415);
});

test("the host tells a web client the address it was reached at", async () => {
  const direct = await fetch(`${base}/assets/host.json`);
  assert.deepEqual(await direct.json(), { origin: base });

  const proxied = await fetch(`${base}/assets/host.json`, {
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "imp.tail.ts.net",
    },
  });

  assert.deepEqual(await proxied.json(), { origin: "https://imp.tail.ts.net" });
});

test("the shell lists the installed apps and the running version", async () => {
  assert.deepEqual(await first("apps"), [
    {
      id: "todos",
      name: "Todos",
      description: "A list of things to do. Your imp can read and change it.",
      symbol: "symbol:checkmark",
      cover: "assets/art/todos.jpg",
      draft: false,
      undo: "",
    },
  ]);
  assert.deepEqual(await first("version"), { version: "dev" });
});

test("the computer's state rides on the account stream, and the screen's page has a stream of its own", async () => {
  const account = await first("account");

  assert.ok(isRow(account) && isRow(account.computer));
  assert.equal(account.computer.kind, "dev");
  assert.equal(account.computer.name, "This computer (development)");

  // host/src/computer/screen.html, in a tab of its own, reads the computer's state from here.
  const computer = await first("computer");
  const page = await fetch(`${base}/computer/screen`);

  assert.ok(isRow(computer));
  assert.equal(computer.name, "This computer (development)");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /\/api\/live\/computer/);
});

test("a message is refused until ChatGPT is signed in", async () => {
  await until("account", withStatus("signedOut"));
  assert.deepEqual(
    await call("chatSend", ["Hello", ""]),
    refused("Sign in with ChatGPT first.")
  );
});

test("a sign-in that cannot reach ChatGPT says why", async () => {
  const failed = until("account", withStatus("failed"));
  assert.deepEqual(await call("accountSignIn", []), done);

  assert.match(
    JSON.stringify((await failed)?.error),
    /^"The host could not reach ChatGPT: getaddrinfo \w+ auth\.invalid"$/
  );
});

test("signing in shows the device code, then the account", async () => {
  const waiting = until("account", withStatus("waiting"));
  assert.deepEqual(await call("accountSignIn", []), done);
  assert.deepEqual(await waiting, {
    status: "waiting",
    code: "TEST-1234",
    url: "https://auth.openai.com/codex/device",
    error: "",
    email: "",
    plan: "",
  });
  assert.deepEqual(await until("account", withStatus("signedIn")), {
    status: "signedIn",
    code: "",
    url: "",
    error: "",
    email: "tester@example.com",
    plan: "plus",
  });
});

test("a todo added from the app's view is listed, and one without a title is refused", async () => {
  assert.deepEqual(await first("todosList"), []);
  assert.deepEqual(await call("todosAdd", ["Pack camera"]), done);
  assert.deepEqual(
    await call("todosAdd", ["  "]),
    refused("A todo needs a title.")
  );
  assert.deepEqual(await first("todosList"), [
    { id: "1", title: "Pack camera", done: false },
  ]);
});

test("an open list hears of a change without asking again", async () => {
  const ticked = until("todosList", (answer) =>
    rows(answer).some((todo) => todo.done === true) ? answer : undefined
  );

  assert.deepEqual(await call("todosSetDone", ["1", true]), done);
  assert.deepEqual(await ticked, [
    { id: "1", title: "Pack camera", done: true },
  ]);
  assert.deepEqual(
    await call("todosSetDone", ["99", true]),
    refused("No todo with id 99.")
  );
  assert.deepEqual(
    await call("todosNothing", []),
    refused("The todos app has no operation named nothing.")
  );
});

test("the assistant adds a todo with the app's tool, and the transcript says what it did", async () => {
  assert.deepEqual(
    await call("chatSend", ["  "]),
    refused("Write a message first.")
  );
  assert.deepEqual(
    await call("chatSend", ["Please add todo: Book train to Kraków", ""]),
    done
  );
  await until("todosList", (answer) =>
    todoTitles(answer).includes("Book train to Kraków") ? answer : undefined
  );

  const messages = await until(
    "chat",
    settledChat((all) => all.at(-1)?.text === "Done.")
  );

  assert.deepEqual(
    messages.map(({ id: _id, ...row }) => row),
    [
      said("user", "Please add todo: Book train to Kraków"),
      {
        role: "activity",
        text: '{"ok":true,"error":""}',
        title: "Todos · Add",
        detail: "Book train to Kraków",
        icon: "symbol:checkmark",
        failed: false,
      },
      said("assistant", "Done."),
    ]
  );
});

test("a message sent beside an open app reaches the agent with the app's name, and the transcript without it", async () => {
  assert.deepEqual(
    await call("chatSend", ["Add todo: Call the vet", "todos"]),
    done
  );

  const messages = await until(
    "chat",
    settledChat((all) => all.length === 6 && all.at(-1)?.text === "Done.")
  );

  assert.equal(messages[3]?.text, "Add todo: Call the vet");
  assert.deepEqual(todoTitles(await first("todosList")), [
    "Pack camera",
    "Book train to Kraków",
    "Call the vet",
  ]);
});

test("the imp remembers what it is told, Settings shows it, and the person can make it forget", async () => {
  const atFirst = await until(
    "account",
    remembered(() => true)
  );

  assert.deepEqual(atFirst, []);
  assert.deepEqual(
    await call("chatSend", ["Please remember: Prefers trains to planes", ""]),
    done
  );
  assert.deepEqual(
    await until(
      "account",
      remembered((entries) => entries.length > 0)
    ),
    [
      {
        id: "user",
        title: "You",
        kind: "",
        facts: ["Prefers trains to planes"],
        links: [],
      },
    ]
  );
  await until(
    "chat",
    settledChat(
      (all) => all.at(-2)?.text === "Remembered 1 new fact about user."
    )
  );

  const forgotten = until(
    "account",
    remembered((entries) => entries.length === 0)
  );

  assert.deepEqual(await call("memoryForget", ["user", ""]), done);
  assert.deepEqual(await forgotten, []);
});

test("after a chat the imp remembers what it learned on its own, without a tool call", async () => {
  assert.deepEqual(
    await call("chatSend", ["By the way, I live in Gdańsk now.", ""]),
    done
  );

  const entries = await until(
    "account",
    remembered((all) => all.length > 0)
  );

  assert.deepEqual(
    entries.map(({ id, facts }) => ({ id, facts })),
    [{ id: "user", facts: ["Lives in Gdańsk"] }]
  );
  assert.deepEqual(await call("memoryForget", ["user", ""]), done);
});

// ---- The studio: the agent previews an app it wrote; the person saves, discards and undoes ----

// A preview builds the shell, so these tests need the Exact checkout the host builds with (HostOptions.exact): EXACT
// names it. Without one they are skipped.
const exact =
  process.env.EXACT ?? path.resolve(repo, "..", "..", "tools", "exact");

const it = existsSync(path.join(exact, "scripts", "app-cli.mjs"))
  ? test
  : test.skip;

const starter = readFileSync(
  path.join(repo, "host", "studio", "starter", "server.ts"),
  "utf-8"
);

/** A change to the starter's server.ts that keeps its migrations: the notes read in capitals. */
const capitals = ["row.text }", "row.text.toUpperCase() }"] as const;

const ready = (data: string) =>
  `The preview is ready: the user sees Notes in its tab, on ${data}, with Save and Discard. Tell them what to try; only they can save.`;

/** The notes app's folder in the agent's workspace, a directory on this machine: app_code says where it wrote it. */
let notesDir = "";
let previews = 0;

const inNotes = (name: string) =>
  readFileSync(path.join(notesDir, name), "utf-8");

/** Writes the starter's server.ts with one change into the workspace and has the agent preview it. */
async function preview(from: string, to: string) {
  const changed = starter.replace(from, to);

  assert.notEqual(changed, starter);
  writeFileSync(path.join(notesDir, "server.ts"), changed);
  previews += 1;

  return await toolRow(`Please preview app: notes (change ${previews})`);
}

/** The notes app as the shell shows it: whether it is a draft, what Undo does, and the texts its read answers. */
const notes = async () => {
  const app = rows(await first("apps")).find(({ id }) => id === "notes");
  const texts = rows(await first("notesNotes")).map((note) => note.text);

  return { draft: app?.draft, undo: app?.undo, texts };
};

const draft = (...texts: string[]) => ({ draft: true, undo: "", texts });

const saved = (undo: string, ...texts: string[]) => ({
  draft: false,
  undo,
  texts,
});

it("app_code writes a starter into the agent's workspace, and preview_app shows it as a draft on empty data", async () => {
  const wrote = await toolRow("Please write app code: notes");

  assert.equal(wrote.title, "Opened an app's code");
  notesDir =
    /Wrote (\S+\/apps\/notes)\/ \(a starter app \(a list of notes\)/.exec(
      JSON.stringify(wrote.text)
    )?.[1] ?? "";
  assert.equal(inNotes("server.ts"), starter);
  assert.match(inNotes("app.json"), /"id": "notes",\n {2}"name": "Notes"/);
  assert.ok(existsSync(path.join(notesDir, "..", "GUIDE.md")));
  assert.ok(existsSync(path.join(notesDir, "..", "sdk.ts")));
  assert.deepEqual(await first("build"), { id: "repo" });
  assert.deepEqual(await toolRow("Please preview app: notes"), {
    title: "Built a preview",
    text: ready("empty data (the app is new)"),
    failed: false,
  });
  assert.deepEqual(await notes(), draft());
  assert.deepEqual(await call("notesAddNote", ["Draft only"]), done);
  assert.deepEqual(await notes(), draft("Draft only"));
  // The host serves the shell it built with the draft's screen.
  assert.notDeepEqual(await first("build"), { id: "repo" });
  assert.equal((await fetch(`${base}/`)).status, 200);
});

it("only a draft is saved or discarded and only a save undone; Save makes the draft the app, on the person's data", async () => {
  const refusals = await Promise.all(
    [
      ["appsUndo", "notes"],
      ["appsSave", "todos"],
      ["appsDiscard", "todos"],
      ["appsUndo", "todos"],
    ].map(async ([source = "", app = ""]) => await call(source, [app]))
  );

  assert.deepEqual(refusals, [
    refused("Save or discard the preview first."),
    refused("The todos app has no preview to save."),
    refused("The todos app has no preview to discard."),
    refused("The todos app has no save to undo."),
  ]);
  assert.deepEqual(await call("appsSave", ["notes"]), done);
  // What was tried in the draft went with it. Undoing the save that made the app would remove the app.
  assert.deepEqual(await notes(), saved("remove"));
  // The save is a version of the apps' code the backup keeps, after the one the host started with.
  await until("account", (answer) =>
    isRow(answer) && isRow(answer.backup) && answer.backup.versions === 2
      ? answer
      : undefined
  );
  assert.deepEqual(await call("notesAddNote", ["Kept"]), done);
});

it("a change previews on a copy of the data, the next preview keeps the draft's entries, and Undo brings back the version before", async () => {
  const shown = await preview(...capitals);

  assert.equal(shown.text, ready("a copy of the user's data"));
  assert.deepEqual(await call("notesAddNote", ["Draft only"]), done);
  assert.deepEqual(await notes(), draft("KEPT", "DRAFT ONLY"));
  await preview("row.text }", 'row.text + "!" }');
  assert.deepEqual(await notes(), draft("Kept!", "Draft only!"));

  // A version saved over more than 48 hours ago goes with the next save, unless it is the newest.
  const history = path.join(dataDir, "code", "notes", "history");

  mkdirSync(path.join(history, "1000"));
  assert.deepEqual(await call("appsSave", ["notes"]), done);
  assert.equal(readdirSync(history).length, 2);
  assert.ok(!existsSync(path.join(history, "1000")));
  // The data's structure did not change, so Undo keeps the data.
  assert.deepEqual(await notes(), saved("keep", "Kept!"));
  assert.deepEqual(await call("notesAddNote", ["Later"]), done);
  assert.deepEqual(await call("appsUndo", ["notes"]), done);
  assert.deepEqual(await notes(), saved("remove", "Kept", "Later"));
});

it("a saved migration cannot change; a new one is saved, and undoing that save restores the data from before it", async () => {
  const changed = await preview("text TEXT NOT NULL", "text TEXT");

  assert.equal(changed.failed, true);
  assert.match(
    JSON.stringify(changed.text),
    /Migration 1 in server\.ts differs/
  );
  assert.deepEqual(await notes(), saved("remove", "Kept", "Later"));
  await preview('NOT NULL)"]', 'NOT NULL)", "CREATE TABLE tags (name TEXT)"]');
  assert.deepEqual(await call("appsSave", ["notes"]), done);
  assert.deepEqual(await call("notesAddNote", ["After"]), done);
  assert.deepEqual(await notes(), saved("data", "Kept", "Later", "After"));
  assert.deepEqual(await call("appsUndo", ["notes"]), done);
  assert.deepEqual(await notes(), saved("remove", "Kept", "Later"));
});

it("a host started again has the saved app, its draft and its build; Discard drops the draft, and Undo the app the save made", async () => {
  await preview(...capitals);

  const build = await first("build");

  await startTestHost();
  assert.deepEqual(await first("build"), build);
  // Once the draft runs again, the host builds the shell again; it keeps the three newest builds.
  await until(
    "build",
    (answer) => (isDeepStrictEqual(answer, build) ? undefined : answer),
    180_000
  );
  assert.deepEqual(await notes(), draft("KEPT", "LATER"));
  const builds = readdirSync(path.join(dataDir, "builds"));

  assert.equal(builds.filter((name) => !name.includes(".")).length, 3);
  assert.deepEqual(await call("appsDiscard", ["notes"]), done);
  assert.deepEqual(await notes(), saved("remove", "Kept", "Later"));
  assert.deepEqual(await call("appsUndo", ["notes"]), done);
  assert.equal(rows(await first("apps")).length, 1);
  assert.equal((await fetch(`${base}/api/live/notesNotes`)).status, 404);
  assert.ok(!existsSync(path.join(dataDir, "code", "notes")));
});

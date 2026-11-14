// The person's conversations and the imp's tricks, as the client uses them: the sidebar lists the conversations with
// something said in them, New chat opens an empty one, and any listed one can be shown again; the tricks the machine's
// agent-browser knows ride on the account stream. The test host's agent-browser is a stand-in (scripts/test-host.ts).
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Json } from "../../sdk/app.ts";
import {
  call,
  dataDir,
  done,
  first,
  isRow,
  refused,
  type Row,
  rows,
  startTestHost,
  stopTestHost,
  toolRow,
  until,
} from "./harness.ts";

type Chats = {
  readonly current: Json | undefined;
  readonly messages: Row[];
  readonly list: Row[];
};

/** The open conversation and the sidebar's list, once the imp is idle and `accept` takes them. */
const chatsWhen =
  (accept: (chats: Chats) => boolean) =>
  (answer: Json): Chats | undefined => {
    const chats =
      isRow(answer) && answer.busy === false
        ? {
            current: answer.current,
            messages: rows(answer.messages),
            list: rows(answer.conversations),
          }
        : undefined;

    return chats && accept(chats) ? chats : undefined;
  };

const isText = (value: Json | undefined): value is string =>
  typeof value === "string";

const titles = (chats: Chats) => chats.list.map((c) => c.title);

before(async () => {
  await startTestHost();
  assert.deepEqual(await call("accountSignIn", []), done);
  await until("account", (answer) =>
    isRow(answer) && answer.status === "signedIn" ? answer : undefined
  );
});

after(async () => {
  await stopTestHost();
  rmSync(dataDir, { recursive: true, force: true });
});

test("the tricks the machine's agent-browser knows ride on the account stream, by title", async () => {
  const tricks = await until("account", (answer) => {
    const list = isRow(answer) ? rows(answer.tricks) : [];

    return list.length > 0 ? list : undefined;
  });

  assert.deepEqual(tricks, [
    {
      name: "hn-search",
      title: "Search Hacker News",
      site: "hn.algolia.com",
      params: ["query"],
    },
    {
      name: "parcel",
      title: "Track a parcel",
      site: "inpost.pl",
      params: ["number"],
    },
  ]);
});

/** The transcript's row for the command the agent ran: its title and its detail. */
async function commandRow(command: string) {
  await toolRow(`Please run: ${command}`);

  const { messages } = await until(
    "chat",
    chatsWhen(() => true)
  );

  const { title, detail } = messages.at(-2) ?? {};

  return [title, detail];
}

test("the transcript says what the imp did in the browser in words, not as a command", async () => {
  assert.deepEqual(
    await commandRow(
      "agent-browser flow save hn-search --description 'Search Hacker News' --param query=exact"
    ),
    ["Learned a trick", "Search Hacker News"]
  );
  assert.deepEqual(
    await commandRow("agent-browser flow run hn-search --param query=expo"),
    ["Ran a trick", "hn-search --param query=expo"]
  );
  assert.deepEqual(await commandRow("agent-browser open example.com"), [
    "Opened a page",
    "example.com",
  ]);
  assert.deepEqual(await commandRow("ls -la"), ["Ran a command", "ls -la"]);
});

test("New chat opens an empty conversation, which the sidebar lists once something is said in it", async () => {
  const start = await until(
    "chat",
    chatsWhen(() => true)
  );

  const [earlier] = start.list;

  assert.equal(start.list.length, 1);
  assert.ok(isRow(earlier) && isText(earlier.id));
  assert.equal(earlier.id, start.current);

  assert.deepEqual(await call("chatNew", []), done);

  const fresh = await until(
    "chat",
    chatsWhen((c) => c.current !== start.current)
  );

  assert.deepEqual(fresh.messages, []);
  assert.deepEqual(titles(fresh), titles(start));

  // A second New chat reuses the empty one.
  assert.deepEqual(await call("chatNew", []), done);
  assert.equal(
    (
      await until(
        "chat",
        chatsWhen(() => true)
      )
    ).current,
    fresh.current
  );

  assert.deepEqual(await call("chatSend", ["Hello in a new chat", ""]), done);

  const said = await until(
    "chat",
    chatsWhen((c) => c.list.length === 2 && c.messages.length > 1)
  );

  assert.deepEqual(titles(said), ["Hello in a new chat", earlier.title]);
  assert.equal(said.messages[0]?.text, "Hello in a new chat");

  assert.deepEqual(await call("chatShow", [earlier.id]), done);

  const shown = await until(
    "chat",
    chatsWhen((c) => c.current === earlier.id)
  );

  assert.deepEqual(shown.messages, start.messages);
  assert.deepEqual(
    await call("chatShow", ["999"]),
    refused("That conversation is gone.")
  );
});

test("a host started again keeps the conversations, and one from before there were several adopts its only one", async () => {
  const kept = await until(
    "chat",
    chatsWhen(() => true)
  );

  await startTestHost();
  assert.deepEqual(
    await until(
      "chat",
      chatsWhen(() => true)
    ),
    kept
  );

  // A host from before there were several conversations has none listed: its one conversation, the root, is adopted.
  await stopTestHost();
  rmSync(path.join(dataDir, "conversations.json"));
  await startTestHost();

  const adopted = await first("chat");
  const root = kept.list.at(-1);

  assert.ok(isRow(adopted) && isRow(root));
  assert.equal(adopted.current, root.id);
  assert.deepEqual(rows(adopted.conversations), [root]);
});

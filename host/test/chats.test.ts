// The person's conversations and the imp's tricks, as the client uses them: the sidebar lists the conversations with
// something said in them, New chat opens an empty one, and any listed one can be shown again; the tricks the machine's
// agent-browser knows ride on the account stream. The test host's agent-browser is a stand-in (scripts/test-host.ts).
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Json } from "../../sdk/app.ts";
import {
  base,
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
  readonly archived: Row[];
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
            archived: rows(answer.archived),
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

/** The transcript's row for the command the agent ran: its title, its detail, and for a failed one, why. */
async function commandRow(command: string) {
  await toolRow(`Please run: ${command}`);

  const { messages } = await until(
    "chat",
    chatsWhen(() => true)
  );

  const { title, detail, failed, text } = messages.at(-2) ?? {};

  return failed === true ? [title, detail, text] : [title, detail];
}

// The test host's agent-browser only lists tricks, so every other browser command fails, and its row says so.
test("the transcript says what the imp did in the browser in words, not as a command", async () => {
  assert.deepEqual(
    await commandRow(
      "agent-browser flow save hn-search --description 'Search Hacker News' --param query=exact"
    ),
    [
      "Couldn't learn a trick",
      "Search Hacker News",
      "agent-browser (test): only flow list",
    ]
  );
  assert.deepEqual(
    await commandRow("agent-browser flow run hn-search --param query=expo"),
    [
      "A trick failed",
      "hn-search --param query=expo",
      "agent-browser (test): only flow list",
    ]
  );
  assert.deepEqual(await commandRow("agent-browser open example.com"), [
    "Couldn't open a page",
    "example.com",
    "agent-browser (test): only flow list",
  ]);
  assert.deepEqual(await commandRow("ls -la"), ["Ran a command", "ls -la"]);
});

// The shell shows the computer's screen above the composer while `browsing`: at work, with a browser step the latest.
test("the chat says the imp is browsing while its latest step drives the browser, and not once it moves on", async () => {
  /** A chat state of the turn for `message` while the imp works, with `titles` its activity rows and `browsing`. */
  const reaches = async (
    message: string,
    titles: readonly string[],
    browsing: boolean
  ) =>
    await until("chat", (answer) => {
      const all = isRow(answer) ? rows(answer.messages) : [];
      const asked = all.findLastIndex((m) => m.text === message);
      const steps = all.slice(asked + 1).filter((m) => m.role === "activity");

      return isRow(answer) &&
        answer.busy === true &&
        answer.browsing === browsing &&
        asked !== -1 &&
        JSON.stringify(steps.map((m) => m.title)) === JSON.stringify(titles)
        ? answer
        : undefined;
    });

  const idle = async () =>
    await until("chat", (answer) =>
      isRow(answer) && answer.busy === false ? answer : undefined
    );

  // The browser step runs for two seconds: the screen shows from when the imp asks for it, before it answers.
  const browse = "run: sleep 2; agent-browser open example.com";

  assert.deepEqual(await call("chatSend", [browse, ""]), done);
  await reaches(browse, [], true);
  assert.equal((await idle()).browsing, false);

  // A step after the browser's, while it runs, is not browsing, though a browser step came before it.
  const moveOn = "run: agent-browser open example.com | then run: sleep 2";

  assert.deepEqual(await call("chatSend", [moveOn, ""]), done);
  await reaches(moveOn, ["Couldn't open a page"], false);
  await idle();
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

test("Archive moves a chat to Archived, archiving the open one opens a new chat, and Restore brings one back", async () => {
  const start = await until(
    "chat",
    chatsWhen(() => true)
  );

  const other = start.list.find((c) => c.id !== start.current);

  assert.ok(other && isText(other.id));

  // A chat that is not open leaves the list; the open one stays open.
  assert.deepEqual(await call("chatArchive", [other.id]), done);

  const without = await until(
    "chat",
    chatsWhen((c) => !c.list.some((l) => l.id === other.id))
  );

  assert.equal(without.current, start.current);
  assert.deepEqual(without.messages, start.messages);
  assert.deepEqual(without.archived, [other]);

  // The open chat gives way to an empty one.
  assert.deepEqual(await call("chatNew", []), done);
  assert.deepEqual(await call("chatSend", ["Archive me while open", ""]), done);

  const open = await until(
    "chat",
    chatsWhen((c) => c.list[0]?.title === "Archive me while open")
  );

  assert.deepEqual(await call("chatArchive", [open.current ?? ""]), done);

  const replaced = await until(
    "chat",
    chatsWhen((c) => c.current !== open.current)
  );

  assert.deepEqual(replaced.messages, []);
  assert.deepEqual(titles(replaced), titles(without));
  // The latest written in first.
  assert.deepEqual(
    replaced.archived.map((c) => c.title),
    ["Archive me while open", other.title]
  );
  assert.deepEqual(
    await call("chatArchive", ["999"]),
    refused("That conversation is gone.")
  );

  // Restore puts it back in the list, where its last message places it, and the open chat stays open.
  assert.deepEqual(await call("chatRestore", [other.id]), done);

  const restored = await until(
    "chat",
    chatsWhen((c) => c.list.some((l) => l.id === other.id))
  );

  assert.deepEqual(titles(restored), titles(start));
  assert.equal(restored.current, replaced.current);
  assert.deepEqual(
    restored.archived.map((c) => c.title),
    ["Archive me while open"]
  );
  assert.deepEqual(
    await call("chatRestore", ["999"]),
    refused("That conversation is gone.")
  );
});

test("the sidebar's list says which chats the imp is still at work in, also after the person moved to another", async () => {
  assert.deepEqual(await call("chatNew", []), done);
  assert.deepEqual(
    await call("chatSend", ["Keep at it, run: sleep 3", ""]),
    done
  );
  assert.deepEqual(await call("chatNew", []), done);

  const entry = (answer: Json) =>
    isRow(answer)
      ? rows(answer.conversations).find(
          (c) => c.title === "Keep at it, run: sleep 3"
        )
      : undefined;

  const running = await until("chat", (answer) =>
    entry(answer)?.working === true ? answer : undefined
  );

  // The open chat is the new, empty one, and the others listed are idle.
  assert.ok(isRow(running));
  assert.equal(running.busy, false);
  assert.deepEqual(
    rows(running.conversations)
      .filter((c) => c.working === true)
      .map((c) => c.title),
    ["Keep at it, run: sleep 3"]
  );

  await until("chat", (answer) =>
    entry(answer)?.working === false ? answer : undefined
  );
});

test("beside an app opens the latest chat started beside it, or a new chat until there is one, also after a restart", async () => {
  assert.deepEqual(await call("appsInstall", ["todos"]), done);

  const start = await until(
    "chat",
    chatsWhen(() => true)
  );

  // No chat is about Todos yet: the one open gives way to a new chat.
  assert.deepEqual(await call("chatShow", [start.list[0]?.id ?? ""]), done);
  assert.deepEqual(await call("chatBeside", ["todos"]), done);

  const blank = await until(
    "chat",
    chatsWhen((c) => c.current !== start.list[0]?.id)
  );

  assert.deepEqual(blank.messages, []);
  assert.deepEqual(await call("chatSend", ["About my todos", "todos"]), done);
  await until(
    "chat",
    chatsWhen((c) => c.list[0]?.title === "About my todos")
  );

  // Another chat opened, and one written in from the chat page, do not take Todos' place.
  assert.deepEqual(await call("chatNew", []), done);
  assert.deepEqual(await call("chatSend", ["Not about todos", ""]), done);
  await until(
    "chat",
    chatsWhen((c) => c.list[0]?.title === "Not about todos")
  );
  assert.deepEqual(await call("chatBeside", ["todos"]), done);

  const beside = await until(
    "chat",
    chatsWhen((c) => c.current === blank.current)
  );

  assert.equal(beside.messages[0]?.text, "About my todos");

  // A page that is no app's opens a new chat, as opening Imp on it does.
  assert.deepEqual(await call("chatBeside", ["settings"]), done);
  await until(
    "chat",
    chatsWhen((c) => c.current !== blank.current && c.messages.length === 0)
  );

  await startTestHost();
  assert.deepEqual(await call("chatBeside", ["todos"]), done);
  assert.equal(
    (
      await until(
        "chat",
        chatsWhen((c) => c.current === blank.current)
      )
    ).messages[0]?.text,
    "About my todos"
  );
});

// A 2×1 PNG: one red pixel, one blue.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABAQMAAADO7O3JAAAABlBMVEX/AAAAAP9sof2OAAAACklEQVQI12NwAAAAQgBBg7nsrQAAAABJRU5ErkJggg==";

const image = (mimeType: string) => ({ type: "image", data: PNG, mimeType });

test("an image sent with a message reaches the model, and its row links the host's copy of it", async () => {
  assert.deepEqual(await call("chatNew", []), done);
  assert.deepEqual(
    await call("chatSend", ["What is on this?", "", [image("image/png")]]),
    done
  );

  const { messages } = await until(
    "chat",
    chatsWhen((c) => c.messages.at(-1)?.role === "assistant")
  );

  const [person, answer] = messages;

  assert.equal(person?.text, "What is on this?");
  assert.equal(answer?.text, "I see image/png.");

  const [link] = Array.isArray(person?.images) ? person.images : [];

  assert.ok(isText(link));
  assert.match(link, /^\/api\/image\/\d+\/\d+\/0$/);

  const served = await fetch(`${base}${link}`);

  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.deepEqual(
    Buffer.from(await served.arrayBuffer()),
    Buffer.from(PNG, "base64")
  );
  // The message has one image, and the host serves no other.
  assert.equal((await fetch(`${base}${link.replace(/0$/, "1")}`)).status, 404);
});

test("an image needs no words, and names its chat; images the model cannot take are refused", async () => {
  assert.deepEqual(await call("chatNew", []), done);
  assert.deepEqual(
    await call("chatSend", ["", "", [image("image/jpeg")]]),
    done
  );

  const sent = await until(
    "chat",
    chatsWhen((c) => c.messages.at(-1)?.role === "assistant")
  );

  assert.equal(sent.list[0]?.title, "An image");
  assert.equal(sent.messages[0]?.text, "");

  const why = refused(
    "Imp takes up to 4 PNG, JPEG, GIF or WebP images of at most 5 MB each."
  );

  assert.deepEqual(
    await call("chatSend", ["Look", "", [image("image/svg+xml")]]),
    why
  );
  assert.deepEqual(
    await call("chatSend", [
      "Look",
      "",
      Array.from({ length: 5 }, () => image("image/png")),
    ]),
    why
  );
  assert.deepEqual(
    await call("chatSend", ["", "", []]),
    refused("Write a message first.")
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

// The imp's routines, as the client uses them: the imp saves one from the chat, the sidebar lists it on the account
// stream, and the person runs it now, opens its conversation, pauses it and deletes it. A run happens in the routine's
// own conversation, out of the sidebar's Recent list, and teaches the memory nothing, since the person said nothing.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, before, test } from "node:test";
import type { Json } from "../../sdk/app.ts";
import {
  call,
  dataDir,
  done,
  isRow,
  refused,
  type Row,
  rows,
  settledChat,
  startTestHost,
  stopTestHost,
  toolRow,
  until,
} from "./harness.ts";

/** The routines on the account stream, once `accept` takes them. */
const routinesWhen = async (accept: (routines: Row[]) => boolean) =>
  await until(
    "account",
    (answer) => {
      const list = isRow(answer) ? rows(answer.routines) : undefined;

      return list && accept(list) ? list : undefined;
    },
    30_000
  );

/** The open conversation once the imp is idle and `accept` takes it. */
const chatWhen = async (accept: (chat: Row) => boolean) =>
  await until("chat", (answer) =>
    isRow(answer) && answer.busy === false && accept(answer)
      ? answer
      : undefined
  );

const isText = (value: Json | undefined): value is string =>
  typeof value === "string";

/** A field the host answers as text; "" when it answered something else. */
const textOf = (value: Json | undefined) => (isText(value) ? value : "");

const facts = (answer: Json) => {
  const memory = isRow(answer) && isRow(answer.memory) ? answer.memory : {};

  return rows(memory.entries).flatMap((entry) =>
    Array.isArray(entry.facts) ? entry.facts : []
  );
};

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

test("the imp refuses a schedule that is not cron or runs more often than every 15 minutes", async () => {
  const short = await toolRow("Please save routine: Bad | 0 8 * * | Check");

  assert.match(textOf(short.text), /^Not saved: A schedule has five fields/);

  const often = await toolRow(
    "Please save routine: Busy | */5 * * * * | Check"
  );

  assert.equal(
    often.text,
    "Not saved: A routine runs at most every 15 minutes."
  );
  assert.deepEqual(await routinesWhen(() => true), []);
});

test("a routine the imp saves is listed with its next run, and runs now in a conversation of its own", async () => {
  const saved = await toolRow(
    "Please save routine: Weather | 0 8 * * 1-5 | Note that I live in Oslo"
  );

  assert.match(
    textOf(saved.text),
    /^Saved\. It first runs \w{3} \d+ \w{3}, 08:00 \(Europe\/Warsaw\)/
  );

  const [listed] = await routinesWhen((list) => list.length === 1);

  assert.ok(isRow(listed));
  assert.equal(listed.name, "Weather");
  assert.equal(listed.instruction, "Note that I live in Oslo");
  assert.match(textOf(listed.next), /, 08:00$/);
  assert.equal(listed.last, "");
  assert.equal(listed.unread, false);

  // The person's message that asked for the routine said "I live in Oslo", which the memory keeps: forget it, so
  // only the run could bring it back.
  await until("account", (answer) =>
    facts(answer).includes("Lives in Oslo") ? true : undefined
  );
  assert.deepEqual(await call("memoryForget", ["user", ""]), done);
  await until("account", (answer) =>
    facts(answer).length === 0 ? true : undefined
  );

  const home = await chatWhen(() => true);

  assert.deepEqual(await call("routinesRun", [listed.id ?? ""]), done);

  const [ran] = await routinesWhen(
    (list) => list[0]?.unread === true && list[0].running === false
  );

  assert.ok(isRow(ran));
  assert.notEqual(ran.last, "");
  assert.equal(ran.failed, false);

  // The run stayed in its own conversation: the open chat and the Recent list are as they were.
  const after = await chatWhen(() => true);

  assert.equal(after.current, home.current);
  assert.deepEqual(after.conversations, home.conversations);

  // Something the person says teaches the memory; the routine's run, which said "I live in Oslo", taught it nothing.
  assert.deepEqual(
    await call("chatSend", ["By the way, I live in Gdańsk now.", ""]),
    done
  );

  const known = await until("account", (answer) =>
    facts(answer).includes("Lives in Gdańsk") ? facts(answer) : undefined
  );

  assert.ok(!known.includes("Lives in Oslo"), JSON.stringify(known));

  // Opening it shows the run as the routine's instruction, without the line the host added, and marks it read.
  assert.deepEqual(await call("routinesOpen", [ran.id ?? ""]), done);

  const opened = await chatWhen((chat) => chat.current === ran.id);

  assert.equal(opened.routine, "Weather");
  assert.deepEqual(
    rows(opened.messages).map((m) => [m.role, m.text]),
    [
      ["user", "Note that I live in Oslo"],
      ["assistant", "Hello from the test model."],
    ]
  );
  await routinesWhen((list) => list[0]?.unread === false);
});

test("a paused routine has no next run until it is resumed; a host started again keeps it", async () => {
  const [routine] = await routinesWhen((list) => list.length === 1);
  const id = textOf(routine?.id);

  assert.deepEqual(await call("routinesPause", [id, true]), done);
  await routinesWhen((list) => list[0]?.paused === true && list[0].next === "");

  assert.deepEqual(await call("routinesPause", [id, false]), done);
  await routinesWhen(
    (list) => list[0]?.paused === false && list[0].next !== ""
  );

  await startTestHost();

  const [kept] = await routinesWhen((list) => list.length === 1);

  assert.equal(kept?.id, id);
  assert.equal(kept?.name, "Weather");
});

test("deleting the open routine drops its conversation and shows the latest chat", async () => {
  const [routine] = await routinesWhen((list) => list.length === 1);
  const id = textOf(routine?.id);

  assert.deepEqual(await call("routinesOpen", [id]), done);
  await chatWhen((chat) => chat.current === id);
  assert.deepEqual(await call("routinesDelete", [id]), done);
  await routinesWhen((list) => list.length === 0);

  const shown = await chatWhen((chat) => chat.current !== id);

  assert.equal(shown.routine, "");
  assert.deepEqual(
    await call("chatShow", [id]),
    refused("That conversation is gone.")
  );
  assert.deepEqual(
    await call("routinesRun", [id]),
    refused("That routine is gone.")
  );
  // The sidebar's chats are what they were.
  await until(
    "chat",
    settledChat((messages) => messages.length > 0)
  );
});

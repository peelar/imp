// What the person is told while they are away, as the client reads it: notices on the account stream, the newest
// first, each naming what it opens. A reply the imp finished, a key it asks for and a routine's run each make one; a
// run that found nothing new does not, and a routine's run is never told as a reply too.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, before, test } from "node:test";
import {
  call,
  dataDir,
  done,
  first,
  isRow,
  type Row,
  rows,
  startTestHost,
  stopTestHost,
  toolRow,
  until,
} from "./harness.ts";

/** The notices on the account stream once `accept` takes them. */
const noticesWhen = async (accept: (notices: Row[]) => boolean) =>
  await until(
    "account",
    (answer) => {
      const list = isRow(answer) ? rows(answer.notices) : undefined;

      return list && accept(list) ? list : undefined;
    },
    30_000
  );

const routinesNow = async () => {
  const answer = await first("account");

  return isRow(answer) ? rows(answer.routines) : [];
};

/** What a notice says, without its id and time. */
const told = ({ kind, title, body, conversation }: Row) => ({
  kind,
  title,
  body,
  conversation,
});

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

test("a reply the imp finishes and a key it asks for are notices that say what they open", async () => {
  assert.deepEqual(await noticesWhen(() => true), []);
  assert.deepEqual(
    await call("chatSend", [
      "Please reply: **Booked** the 9:41 to Kraków.",
      "",
    ]),
    done
  );

  const [reply] = await noticesWhen((list) => list.length === 1);
  const current = await first("chat");

  assert.ok(isRow(reply) && isRow(current));
  assert.deepEqual(told(reply), {
    kind: "reply",
    title: "Please reply: **Booked** the 9:41 to Kraków.",
    body: "Booked the 9:41 to Kraków.",
    conversation: current.current,
  });

  assert.deepEqual(
    await call("chatSend", ["Please ask for a key: github", ""]),
    done
  );

  const list = await noticesWhen((all) => all.length === 3);

  assert.deepEqual(
    list.map((notice) => told(notice)),
    [
      {
        kind: "reply",
        title: "Please reply: **Booked** the 9:41 to Kraków.",
        body: "Done.",
        conversation: current.current,
      },
      {
        kind: "key",
        title: "Your imp asks for a GitHub key",
        body: "To read your issues.",
        conversation: "",
      },
      told(reply),
    ]
  );
  // The newest first, each later than the one before it, so a page tells the new ones by their time.
  assert.ok(
    list.every((n, i) => i === 0 || Number(n.at) < Number(list[i - 1]?.at))
  );
});

test("a routine's run is a notice of what it found, and a run that found nothing new is none", async () => {
  // Saved in the order they run in: the quiet one first, so its run has ended once the other's notice arrives.
  await toolRow(
    "Please save routine: Quiet | 0 8 * * 1-5 | reply: Nothing new."
  );
  await toolRow(
    "Please save routine: Trains | 0 8 * * 1-5 | reply: **Delayed:** the 9:41 now leaves at 9:52.\n\n- Platform 3"
  );

  const [quiet, trains] = await routinesNow();
  const before = await noticesWhen(() => true);

  assert.ok(isRow(quiet) && isRow(trains));
  assert.deepEqual(await call("routinesRun", [quiet.id ?? ""]), done);
  assert.deepEqual(await call("routinesRun", [trains.id ?? ""]), done);

  const list = await noticesWhen((all) =>
    all.some((n) => n.kind === "routine")
  );

  // The run's notice is the only new one: the quiet run made none, and neither run is told as a reply.
  assert.deepEqual(
    list.map((notice) => told(notice)),
    [
      {
        kind: "routine",
        title: "Trains",
        body: "Delayed: the 9:41 now leaves at 9:52. Platform 3",
        conversation: trains.id,
      },
      ...before.map((notice) => told(notice)),
    ]
  );
  assert.equal((await routinesNow())[0]?.running, false);
});

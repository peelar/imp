// The ChatGPT model: ChatGPT refuses a model the account's plan does not cover, so the host moves down its models until
// one answers, keeps that one, and says plainly when none does. The test host's models are faux-1, then faux-2
// (scripts/test-host.ts).
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { after, before, test } from "node:test";
import {
  call,
  dataDir,
  done,
  isRow,
  type Row,
  settledChat,
  startTestHost,
  stopTestHost,
  until,
  vaultReady,
} from "./harness.ts";

before(async () => {
  await startTestHost();
  assert.deepEqual(await call("accountSignIn", []), done);
  await until("account", (answer) =>
    isRow(answer) && answer.status === "signedIn" ? answer : undefined
  );
  await vaultReady();
});

after(async () => {
  await stopTestHost();
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * Sends a message, and answers what the transcript shows after it once the imp is done. A turn that fails is retried
 * with backoff before it settles, so this waits longer than most.
 */
async function reply(message: string): Promise<Row[]> {
  assert.deepEqual(await call("chatSend", [message, ""]), done);

  const messages = await until(
    "chat",
    settledChat((all) =>
      all.some((row) => row.role === "user" && row.text === message)
    ),
    60_000
  );

  return messages.slice(
    messages.findIndex((row) => row.role === "user" && row.text === message) + 1
  );
}

test("when ChatGPT refuses every model, the person is told what that means", async () => {
  const after = await reply("refuse: all");
  const error = after.find((row) => row.role === "error");

  assert.ok(error, JSON.stringify(after));
  assert.match(
    JSON.stringify(error.text),
    /^"Your ChatGPT account can't use any of the models Imp tried \(faux-1, faux-2\)\. .*ChatGPT said: Codex error: The 'faux-2' model is not supported/
  );
});

test("when ChatGPT refuses the model, the imp answers on the next one and stays on it", async () => {
  const refused = await reply("refuse: faux-1");

  assert.deepEqual(
    refused.map(({ role, text }) => ({ role, text })),
    [{ role: "assistant", text: "Answered on faux-2." }]
  );

  const next = await reply("which model?");

  assert.equal(next.at(-1)?.text, "Answered on faux-2.");
});

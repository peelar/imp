// Feature flags (host/src/flags/flags.ts), decided on the host from DATA_DIR/flags.json: a flag the owner turns on in
// Settings stays off until the host starts again, and then it is on. harness.ts starts the host. Run: npm test
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
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
} from "./harness.ts";

const choose = (flags: Record<string, boolean>) => {
  writeFileSync(path.join(dataDir, "flags.json"), JSON.stringify(flags));
};

/** The flags Settings shows, from the account's stream: whether each is on now, and after the next start. */
const flagStates = async () => {
  const account = await first("account");

  return rows(isRow(account) ? account.flags : undefined).map(
    ({ key, on, next }) => ({ key, on, next })
  );
};

before(async () => {
  // The owner chose nothing: every flag is its default.
  choose({});
  await startTestHost();
});

after(async () => {
  await stopTestHost();
  rmSync(dataDir, { recursive: true, force: true });
});

test("turned on in Settings, a flag is kept for the next start and changes nothing until then", async () => {
  assert.deepEqual(await flagStates(), [
    { key: "app-directory", on: false, next: false },
  ]);
  assert.deepEqual(await call("flagsChoose", ["app-directory", true]), done);
  assert.deepEqual(
    await call("flagsChoose", ["no-such-flag", true]),
    refused('There is no feature flag named "no-such-flag".')
  );

  assert.deepEqual(await flagStates(), [
    { key: "app-directory", on: false, next: true },
  ]);
});

test("a flag turned on in Settings is on after a restart", async () => {
  await startTestHost();

  assert.deepEqual(await flagStates(), [
    { key: "app-directory", on: true, next: true },
  ]);
});

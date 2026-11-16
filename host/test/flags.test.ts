// Feature flags (host/src/flags/flags.ts), decided on the host from DATA_DIR/flags.json: the GitHub app stays off
// until the owner turns its flag on in Settings, and then it is back after a restart. harness.ts starts the host. Run: npm test
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
  toolRow,
  until,
  vaultReady,
} from "./harness.ts";

const choose = (flags: Record<string, boolean>) => {
  writeFileSync(path.join(dataDir, "flags.json"), JSON.stringify(flags));
};

const appIds = async () => rows(await first("apps")).map(({ id }) => id);

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

test("with its flag off, the shell lists no GitHub app and nothing reaches it", async () => {
  assert.deepEqual(await appIds(), ["todos"]);
  assert.deepEqual(await call("githubDone", ["o/r#7"]), {
    status: 404,
    body: { error: "no mutation githubDone" },
  });
});

test("with its flag off, the imp can neither open nor preview the GitHub app", async () => {
  await vaultReady();
  assert.deepEqual(await call("accountSignIn", []), done);

  await until("account", (answer) =>
    rows([answer]).some(({ status }) => status === "signedIn")
      ? true
      : undefined
  );

  const offMessage =
    /The github app is behind a feature flag that is off on this host/;

  const opened = await toolRow("Please write app code: github");

  assert.equal(opened.failed, true);
  assert.match(JSON.stringify(opened.text), offMessage);

  const previewed = await toolRow("Please preview app: github");

  assert.equal(previewed.failed, true);
  assert.match(JSON.stringify(previewed.text), offMessage);
  assert.deepEqual(await appIds(), ["todos"]);
});

test("turned on in Settings, a flag is kept for the next start and changes nothing until then", async () => {
  assert.deepEqual(await flagStates(), [
    { key: "github-app", on: false, next: false },
    { key: "app-directory", on: false, next: false },
  ]);
  assert.deepEqual(await call("flagsChoose", ["github-app", true]), done);
  assert.deepEqual(
    await call("flagsChoose", ["no-such-flag", true]),
    refused('There is no feature flag named "no-such-flag".')
  );

  assert.deepEqual(await flagStates(), [
    { key: "github-app", on: false, next: true },
    { key: "app-directory", on: false, next: false },
  ]);
  assert.deepEqual(await appIds(), ["todos"]);
});

test("the GitHub app turned on in Settings is back after a restart", async () => {
  await startTestHost();

  assert.deepEqual(await appIds(), ["github", "todos"]);
  assert.deepEqual((await flagStates())[0], {
    key: "github-app",
    on: true,
    next: true,
  });
});

// Installing and uninstalling apps, through the host's HTTP API: the onboarding installs GitHub and the app directory
// Todos, and Uninstall removes an app with its data, for good. Run: pnpm test
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
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
} from "./harness.ts";

/** Whether the onboarding still shows the person their first app; it rides on the account stream. */
const introducing = async () => {
  const account = await first("account");

  return isRow(account) ? account.introduceApps : undefined;
};

const appIds = async () => rows(await first("apps")).map(({ id }) => id);

before(async () => {
  await startTestHost();
});

after(async () => {
  await stopTestHost();
  rmSync(dataDir, { recursive: true, force: true });
});

test("a new host has no apps until the onboarding installs GitHub, as Imp ships it", async () => {
  assert.equal(await introducing(), true);
  assert.deepEqual(await appIds(), []);
  assert.equal((await fetch(`${base}/api/live/githubInbox`)).status, 404);
  assert.deepEqual(
    await call("appsInstall", ["notes"]),
    refused("Imp ships no app named notes.")
  );

  assert.deepEqual(await call("appsInstall", ["github"]), done);
  assert.equal(await introducing(), false);
  assert.deepEqual(await appIds(), ["github"]);
  // Imp keeps its code, so Imp's updates reach it.
  assert.ok(existsSync(path.join(dataDir, "code", "github", "installed")));
  assert.deepEqual(
    await call("appsInstall", ["github"]),
    refused("The github app is already installed.")
  );
});

test("Todos from the app directory is the person's own, like an app the imp built", async () => {
  assert.deepEqual(await call("appsInstall", ["todos"]), done);
  assert.deepEqual(await appIds(), ["github", "todos"]);
  assert.ok(
    existsSync(path.join(dataDir, "code", "todos", "live", "server.ts"))
  );
});

test("an uninstalled app goes with its data, and installed again it starts empty", async () => {
  assert.deepEqual(await call("todosAdd", ["Pack camera"]), done);

  assert.deepEqual(await call("appsUninstall", ["todos"]), done);
  assert.deepEqual(await appIds(), ["github"]);
  assert.equal((await fetch(`${base}/api/live/todosList`)).status, 404);
  assert.ok(!existsSync(path.join(dataDir, "apps", "todos.sqlite")));
  assert.ok(!existsSync(path.join(dataDir, "code", "todos", "live")));
  assert.deepEqual(
    await call("appsUninstall", ["nothing"]),
    refused("There is no nothing app.")
  );

  assert.deepEqual(await call("appsInstall", ["todos"]), done);
  assert.deepEqual(await first("todosList"), []);
});

test("installed and uninstalled apps stay so when the host starts again, and the onboarding does not ask again", async () => {
  assert.deepEqual(await call("appsUninstall", ["todos"]), done);
  await startTestHost();
  assert.deepEqual(await appIds(), ["github"]);
  assert.deepEqual(await call("appsUninstall", ["github"]), done);
  await startTestHost();
  assert.deepEqual(await appIds(), []);
  assert.equal(await introducing(), false);
});

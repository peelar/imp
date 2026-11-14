// The backup of the apps' code, as the client uses it: the host keeps the apps it starts with as the first version,
// and Settings connects GitHub with a device code. The GitHub CLI is a stand-in (scripts/fake-gh.ts) whose
// repositories are bare git repositories in the host's data directory. The backup rides on the account stream.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Json } from "../../sdk/app.ts";
import {
  call,
  dataDir,
  done,
  first,
  isRow,
  type Row,
  startTestHost,
  stopTestHost,
  until,
} from "./harness.ts";

/** The backup as Settings shows it, once `accept` takes it. */
const backupWhen = (accept: (backup: Row) => boolean) => (answer: Json) => {
  const backup = isRow(answer) ? answer.backup : undefined;

  return isRow(backup) && accept(backup) ? backup : undefined;
};

const withStatus = (status: string) =>
  backupWhen((backup) => backup.status === status);

before(async () => {
  await startTestHost();
});

after(async () => {
  await stopTestHost();
});

test("the host keeps the apps it starts with as the first version, a folder per app", async () => {
  const backup = await until(
    "account",
    backupWhen(({ versions }) => versions === 1)
  );

  assert.deepEqual(backup, {
    git: true,
    status: "off",
    code: "",
    url: "",
    repo: "",
    error: "",
    versions: 1,
    synced: false,
  });
  assert.equal(
    execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
      cwd: path.join(dataDir, "backup"),
      encoding: "utf-8",
    }),
    "todos/app.contract\ntodos/app.json\ntodos/server.ts\n"
  );
});

test("connecting GitHub shows the device code, then pushes every version to the person's private repository", async () => {
  const waiting = until("account", withStatus("waiting"));

  assert.deepEqual(await call("backupConnect", []), done);

  const { code, url } = await waiting;

  assert.deepEqual(
    { code, url },
    { code: "TEST-5678", url: "https://github.com/login/device" }
  );

  const pushed = await until(
    "account",
    backupWhen(({ synced }) => synced === true)
  );

  assert.deepEqual(
    { status: pushed.status, repo: pushed.repo, error: pushed.error },
    { status: "on", repo: "tester/imp-apps", error: "" }
  );
  // The stand-in's GitHub has what the host has.
  assert.equal(
    execFileSync("git", ["rev-list", "--count", "main"], {
      cwd: path.join(dataDir, "github", "tester", "imp-apps.git"),
      encoding: "utf-8",
    }).trim(),
    "1"
  );
});

test("disconnecting stops the backup to GitHub and signs the host out; a sign-in can be cancelled", async () => {
  assert.deepEqual(await call("backupDisconnect", []), done);

  const off = await until("account", withStatus("off"));

  assert.deepEqual(
    { repo: off.repo, synced: off.synced, versions: off.versions },
    { repo: "", synced: false, versions: 1 }
  );

  const waiting = until("account", withStatus("waiting"));

  assert.deepEqual(await call("backupConnect", []), done);
  await waiting;
  assert.deepEqual(await call("backupCancel", []), done);
  assert.equal((await until("account", withStatus("off"))).code, "");
});

test("a host whose kept files were damaged still starts, and reads them as empty", async () => {
  await stopTestHost();
  mkdirSync(path.join(dataDir, "builds"), { recursive: true });

  for (const file of [
    "backup.json",
    "computer.json",
    "secrets-uses.json",
    path.join("builds", "current.json"),
  ]) {
    writeFileSync(path.join(dataDir, file), "{ half written");
  }

  await startTestHost();
  assert.equal((await until("account", withStatus("off"))).repo, "");
  assert.deepEqual(await first("build"), { id: "repo" });
});

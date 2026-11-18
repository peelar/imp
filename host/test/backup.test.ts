// Settings' Connections, as the client uses it: the host keeps every version of the apps' code, connecting GitHub
// signs in with a device code and keeps the token in the vault, and Backup then pushes the versions to GitHub. The
// GitHub CLI (scripts/fake-gh.ts) and GitHub's API (scripts/fake-github.ts) are stand-ins, whose repositories are bare
// git repositories in the host's data directory. Both ride on the account stream.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  rows,
  until,
  vaultReady,
} from "./harness.ts";

/** The backup as Settings shows it, once `accept` takes it. */
const backupWhen = (accept: (backup: Row) => boolean) => (answer: Json) => {
  const backup = isRow(answer) ? answer.backup : undefined;

  return isRow(backup) && accept(backup) ? backup : undefined;
};

/** GitHub's connection as Settings shows it, once `accept` takes it. */
const githubWhen = (accept: (github: Row) => boolean) => (answer: Json) => {
  const github = isRow(answer)
    ? rows(answer.connections).find(({ id }) => id === "github")
    : undefined;

  return github && accept(github) ? github : undefined;
};

const withStatus = (status: string) =>
  backupWhen((backup) => backup.status === status);

before(async () => {
  await startTestHost();
});

after(async () => {
  await stopTestHost();
});

test("an installed app's code is the first version the host keeps, a folder per app", async () => {
  // A new host has no apps: the onboarding installs GitHub.
  assert.deepEqual(await call("appsInstall", ["github"]), done);

  const backup = await until(
    "account",
    backupWhen(({ versions }) => versions === 1)
  );

  assert.deepEqual(backup, {
    git: true,
    status: "off",
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
    "github/app.contract\ngithub/app.json\ngithub/server.ts\n"
  );
});

test("connecting GitHub shows the device code, then keeps the account's key in the vault", async () => {
  await vaultReady();

  const waiting = until(
    "account",
    githubWhen(({ status }) => status === "waiting")
  );

  assert.deepEqual(await call("connectionsConnect", []), done);

  const { code, url } = await waiting;

  assert.deepEqual(
    { code, url },
    { code: "TEST-5678", url: "https://github.com/login/device" }
  );
  assert.deepEqual(
    await until(
      "account",
      githubWhen(({ status }) => status === "on")
    ),
    {
      id: "github",
      label: "GitHub",
      status: "on",
      code: "",
      url: "",
      login: "tester",
      error: "",
    }
  );

  // The token is the owner's key named github, and the sign-in left nothing of it on the host.
  const kept = await until("account", (answer) =>
    isRow(answer) && isRow(answer.secrets)
      ? rows(answer.secrets.secrets).find(({ name }) => name === "github")
      : undefined
  );

  assert.equal(kept.name, "github");
  assert.equal(
    existsSync(path.join(dataDir, "connections", "github-sign-in")),
    false
  );
});

test("turning on Backup pushes every version to the person's private repository", async () => {
  assert.deepEqual(await call("backupTurnOn", []), done);

  const pushed = await until(
    "account",
    backupWhen(({ synced }) => synced === true),
    // The first push starts the egress proxy, which the host downloads first where it has no mitmproxy yet.
    120_000
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

test("disconnecting GitHub takes its key out of the vault and turns Backup off; a sign-in can be cancelled", async () => {
  assert.deepEqual(await call("connectionsDisconnect", []), done);

  const off = await until("account", withStatus("off"));

  assert.deepEqual(
    { repo: off.repo, synced: off.synced, versions: off.versions },
    { repo: "", synced: false, versions: 1 }
  );

  const signedOut = await until("account", (answer) =>
    isRow(answer) &&
    isRow(answer.secrets) &&
    rows(answer.connections).some(({ status }) => status === "off")
      ? answer.secrets
      : undefined
  );

  assert.equal(
    rows(signedOut.secrets).some(({ name }) => name === "github"),
    false
  );
  // Without GitHub, Backup does not turn on.
  assert.deepEqual(await call("backupTurnOn", []), done);
  assert.equal(
    (
      await until(
        "account",
        backupWhen(({ error }) => error !== "")
      )
    ).error,
    "Connect GitHub first."
  );

  const waiting = until(
    "account",
    githubWhen(({ status }) => status === "waiting")
  );

  assert.deepEqual(await call("connectionsConnect", []), done);
  await waiting;
  assert.deepEqual(await call("connectionsCancel", []), done);
  assert.equal(
    (
      await until(
        "account",
        githubWhen(({ status }) => status === "off")
      )
    ).code,
    ""
  );
});

test("a host whose kept files were damaged still starts, and reads them as empty", async () => {
  await stopTestHost();
  mkdirSync(path.join(dataDir, "builds"), { recursive: true });

  for (const file of [
    "backup.json",
    "connections.json",
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

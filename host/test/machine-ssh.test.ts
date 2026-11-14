// The SSH adapter's check of a computer the owner brings (probeSsh), which Settings shows the answer of. `ssh` is a
// stand-in on PATH that records how it was called and answers as the scenario says: a real computer would need an
// SSH server and root to set up, which a test run does not have.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { probeSsh } from "../src/machine-ssh.ts";

const bin = mkdtempSync(path.join(tmpdir(), "imp-fake-ssh-"));
const calls = path.join(bin, "calls");

writeFileSync(
  path.join(bin, "ssh"),
  `#!/bin/sh
printf '%s\\n' "$@" > '${calls}'
case "$SSH_SCENARIO" in
  denied) echo "imp@box: Permission denied (publickey)." >&2; exit 255 ;;
  unreachable) echo "ssh: connect to host box port 22: Connection refused" >&2; exit 255 ;;
  failed) echo "no shell" >&2; exit 1 ;;
  *) printf '%b' "$SSH_STDOUT" ;;
esac
`
);

chmodSync(path.join(bin, "ssh"), 0o755);

process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;

/** Answers the probe as a computer would: its home, `uname -sm`, and the problems the probe looks for. */
const answers = (...lines: string[]) => {
  process.env.SSH_SCENARIO = "answer";
  process.env.SSH_STDOUT = `${lines.join("\n")}\n`;
};

beforeEach(() => {
  answers("/home/imp", "Linux x86_64");
});

test("a Debian computer with passwordless sudo is a machine, at its user's home", async () => {
  assert.deepEqual(await probeSsh({ target: "imp@box" }), {
    home: "/home/imp",
  });
});

test("the port and key in Settings reach ssh, which never asks for a password", async () => {
  await probeSsh({ target: "imp@box:2222", identityFile: "/keys/imp" });

  const args = readFileSync(calls, "utf-8").trim().split("\n");

  assert.ok(args.includes("BatchMode=yes"));
  assert.deepEqual(args.slice(args.indexOf("-p"), args.indexOf("-p") + 2), [
    "-p",
    "2222",
  ]);
  assert.deepEqual(args.slice(args.indexOf("-i"), args.indexOf("-i") + 2), [
    "-i",
    "/keys/imp",
  ]);
  assert.equal(args.at(-2), "imp@box");
});

test("each reason a computer cannot be a machine is said in words", async () => {
  const cases = [
    [["Darwin arm64"], "Imp needs Linux on x86_64 or arm64, not Darwin arm64."],
    [
      ["Linux x86_64", "no-apt"],
      "Imp sets up Debian or Ubuntu computers; this one has no apt-get.",
    ],
    [
      ["Linux aarch64", "no-sudo"],
      "imp@box has no passwordless sudo. Run the setup command on the computer.",
    ],
  ] as const;

  for (const [lines, error] of cases) {
    answers("/home/imp", ...lines);
    // oxlint-disable-next-line no-await-in-loop -- the cases share the stand-in's environment, so they run in turn.
    assert.deepEqual(await probeSsh({ target: "imp@box" }), { error });
  }
});

test("a computer that refuses the host's key, or cannot be reached, says which", async () => {
  process.env.SSH_SCENARIO = "denied";
  assert.deepEqual(await probeSsh({ target: "imp@box" }), {
    error: "imp@box did not let this host sign in.",
    denied: true,
  });
  process.env.SSH_SCENARIO = "unreachable";
  assert.deepEqual(await probeSsh({ target: "imp@box" }), {
    error:
      "Could not reach imp@box: ssh: connect to host box port 22: Connection refused",
  });
  process.env.SSH_SCENARIO = "failed";
  assert.deepEqual(await probeSsh({ target: "imp@box" }), {
    error: "imp@box answered with exit 1: no shell",
  });
});

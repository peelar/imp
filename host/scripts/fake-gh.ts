#!/usr/bin/env node
// The GitHub CLI as the test host's backup sees it (test-host.ts): a device code sign-in that approves itself, an
// account named "tester", and its repositories as bare git repositories next to the sign-in (GH_CONFIG_DIR).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const [command = "", sub = "", name = ""] = process.argv.slice(2);
const config = process.env.GH_CONFIG_DIR;

if (!config) {
  throw new Error("fake gh: GH_CONFIG_DIR is not set");
}

const repo = path.join(path.dirname(config), "github", `${name}.git`);

/** What each `gh <command> <sub>` the backup runs does here. */
const COMMANDS = new Map<string, () => Promise<void> | void>([
  [
    "auth login",
    async () => {
      process.stderr.write(
        "! First copy your one-time code: TEST-5678\nOpen this URL to continue in your web browser: https://github.com/login/device\n"
      );
      await sleep(Number(process.env.TEST_SIGNIN_MS ?? 1500));
      mkdirSync(config, { recursive: true });
      writeFileSync(
        path.join(config, "hosts.yml"),
        "github.com:\n  user: tester\n"
      );
    },
  ],
  [
    "auth logout",
    () => {
      // Nothing kept outside GH_CONFIG_DIR.
    },
  ],
  [
    "api user",
    () => {
      console.log("tester");
    },
  ],
  [
    "repo view",
    () => {
      if (existsSync(repo)) {
        console.log(repo);
      } else {
        console.error(
          `GraphQL: Could not resolve to a Repository with the name '${name}'.`
        );
        process.exitCode = 1;
      }
    },
  ],
  [
    "repo create",
    () => {
      execFileSync("git", [
        "init",
        "--quiet",
        "--bare",
        "--initial-branch=main",
        repo,
      ]);
    },
  ],
]);

const run = COMMANDS.get(`${command} ${sub}`);

if (run) {
  await run();
} else {
  console.error(`fake gh: no ${process.argv.slice(2).join(" ")}`);
  process.exitCode = 1;
}

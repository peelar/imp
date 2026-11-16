#!/usr/bin/env node
// The GitHub CLI as Connect GitHub sees it (test-host.ts): a device code sign-in that approves itself, for an account
// named "tester".
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const [command = "", sub = ""] = process.argv.slice(2);
const config = process.env.GH_CONFIG_DIR;

if (!config) {
  throw new Error("fake gh: GH_CONFIG_DIR is not set");
}

/** What each `gh <command> <sub>` the sign-in runs does here. */
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
    "auth token",
    () => {
      console.log("gho_tester");
    },
  ],
  [
    "api user",
    () => {
      console.log("tester");
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

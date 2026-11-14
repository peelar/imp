#!/usr/bin/env node
// The GitHub CLI as the test host's backup sees it (test-host.ts): a device code sign-in that approves itself, an
// account named "tester", and its repositories as bare git repositories next to the sign-in (GH_CONFIG_DIR).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [command, sub, name] = process.argv.slice(2);
const config = process.env.GH_CONFIG_DIR;
const repo = join(dirname(config), "github", `${name}.git`);

if (command === "auth" && sub === "login") {
	process.stderr.write("! First copy your one-time code: TEST-5678\nOpen this URL to continue in your web browser: https://github.com/login/device\n");
	await new Promise((resolve) => setTimeout(resolve, Number(process.env.TEST_SIGNIN_MS ?? 1500)));
	mkdirSync(config, { recursive: true });
	writeFileSync(join(config, "hosts.yml"), "github.com:\n  user: tester\n");
} else if (command === "auth" && sub === "logout") {
	// Nothing kept outside GH_CONFIG_DIR.
} else if (command === "api") {
	console.log("tester");
} else if (command === "repo" && sub === "view") {
	if (!existsSync(repo)) {
		console.error(`GraphQL: Could not resolve to a Repository with the name '${name}'.`);
		process.exit(1);
	}
	console.log(repo);
} else if (command === "repo" && sub === "create") {
	execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", repo]);
} else {
	console.error(`fake gh: no ${process.argv.slice(2).join(" ")}`);
	process.exit(1);
}

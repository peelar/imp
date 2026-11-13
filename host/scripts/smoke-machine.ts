// Smoke test for the machine adapter: ensure an E2B machine, reach it through pi-env, run a command, write and read a
// file. Run: node scripts/smoke-machine.ts
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { e2bProvider } from "../src/machine-e2b.ts";

const started = Date.now();
const lap = (label: string) => console.log(`${((Date.now() - started) / 1000).toFixed(1)}s ${label}`);

const provider = e2bProvider({ secret: "smoke-test-secret" });
const machine = await provider.ensure({ key: "smoke:test", image: "base", idleSuspendMs: 5 * 60_000 });
lap("machine ensured");
const connection = new Connection({ command: await machine.daemonCommand() });
const info = await connection.info();
lap(`pi-env hello: ${info.os}/${info.arch} v${info.version}, cwd ${info.cwd}`);

const env = new RemoteExecutionEnv({ connection, id: "machine:smoke", cwd: "/home/user/workspace" });
let out = "";
const result = await env.exec("uname -a && node -v && echo hello-from-machine", {
	onOutput: (text: string) => {
		out += text;
	},
}, BACKGROUND_CONTEXT);
lap(`exec ${JSON.stringify(result.ok ? { exitCode: (result.value as { exitCode?: number }).exitCode } : result.error)}:\n${out.trim()}`);

await env.writeFile("/home/user/workspace/smoke.txt", "written through pi-env\n", BACKGROUND_CONTEXT);
const back = await env.readTextFile("/home/user/workspace/smoke.txt", BACKGROUND_CONTEXT);
lap(`file round trip: ${back.ok ? back.value.trim() : JSON.stringify(back.error)}`);

connection.close();
if (process.argv.includes("--destroy")) {
	await provider.destroy("smoke:test");
	lap("destroyed");
}
process.exit(0);

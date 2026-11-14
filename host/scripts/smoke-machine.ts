// Smoke test for a machine adapter: prepare the image, ensure the machine, reach it through pi-env, run a command,
// write and read a file, load an app on the app socket, reach the screen, and use a secret through the egress proxy.
//
//   MACHINE=e2b node scripts/smoke-machine.ts                      (needs E2B_API_KEY; MACHINE_CPUS, MACHINE_MEMORY_MB)
//   MACHINE=ssh MACHINE_SSH=imp@homelab[:port] [MACHINE_SSH_KEY=~/.ssh/key] node scripts/smoke-machine.ts
//   MACHINE=local node scripts/smoke-machine.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry } from "@earendil-works/pi-durable";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import WebSocket from "ws";
import type { MachineProvider } from "../src/machine.ts";
import { Topics } from "../src/live.ts";
import { e2bProvider } from "../src/machine-e2b.ts";
import { localProvider } from "../src/machine-local.ts";
import { machineImage } from "../src/machine-runtime.ts";
import { sshProvider } from "../src/machine-ssh.ts";
import { openSecrets } from "../src/secrets.ts";

const started = Date.now();
const lap = (label: string) => console.log(`${((Date.now() - started) / 1000).toFixed(1)}s ${label}`);

const secret = "smoke-test-secret";
const { MACHINE = "e2b", MACHINE_SSH = "", MACHINE_SSH_KEY } = process.env;
const providers: Record<string, () => MachineProvider> = {
	e2b: () => e2bProvider({ secret }),
	ssh: () => sshProvider({ secret, target: MACHINE_SSH, identityFile: MACHINE_SSH_KEY }),
	local: () => localProvider({ secret, dir: join(tmpdir(), "imp-smoke") }),
};
const provider = providers[MACHINE]!();
const size = { cpus: Number(process.env.MACHINE_CPUS ?? 2), memoryMB: Number(process.env.MACHINE_MEMORY_MB ?? 4096) };
const image = await provider.prepareImage(await machineImage(size));
lap(`image ${image} prepared on ${provider.name}`);
const machine = await provider.ensure({ key: "smoke:test", image, idleSuspendMs: 5 * 60_000 });
lap("machine ensured");
const connection = new Connection({ command: () => machine.daemonCommand() });
const info = await connection.info();
lap(`pi-env hello: ${info.os}/${info.arch} v${info.version}, cwd ${info.cwd}`);

const workspace = provider.workspace("smoke:test");
const env = new RemoteExecutionEnv({ connection, id: "machine:smoke", cwd: workspace });
let out = "";
const result = await env.exec(
	"uname -a && node -v && cat /var/lib/imp/setup && echo hello-from-machine",
	{
		onOutput: (text: string) => {
			out += text;
		},
	},
	BACKGROUND_CONTEXT,
);
lap(`exec ${JSON.stringify(result.ok ? { exitCode: (result.value as { exitCode?: number }).exitCode } : result.error)}:\n${out.trim()}`);

await env.writeFile(`${workspace}/smoke.txt`, "written through pi-env\n", BACKGROUND_CONTEXT);
const back = await env.readTextFile(`${workspace}/smoke.txt`, BACKGROUND_CONTEXT);
lap(`file round trip: ${back.ok ? back.value.trim() : JSON.stringify(back.error)}`);

const endpoint = await machine.appSocket();
const ws = new WebSocket(endpoint.url, { headers: { ...endpoint.headers } });
await new Promise((resolve, reject) => (ws.once("open", resolve), ws.once("error", reject)));
const code = "export default { sources: { ping: () => 'pong' } }";
ws.send(JSON.stringify({ t: "load", app: "smoke", hash: "1", code }));
const loaded = await new Promise((resolve) => ws.once("message", (data) => resolve(JSON.parse(String(data)))));
lap(`app socket: ${JSON.stringify(loaded)}`);
ws.close();

// A secret for httpbin.org's basic-auth check: the request from the machine gets 200 only with the real value, which
// the host's egress proxy adds; the machine holds only the stand-in, in its environment and nowhere else.
const value = Buffer.from("imp:smoke-pass").toString("base64");
const secrets = openSecrets({
	dataDir: mkdtempSync(join(tmpdir(), "imp-smoke-secrets-")),
	toolsDir: join(tmpdir(), "imp-tools"),
	topics: new Topics(),
	registry: createRegistry(),
	machine: async () => machine,
});
const added = await secrets.put({ name: "smoke", service: "other", value, hosts: "httpbin.org", header: "Authorization", prefix: "Basic ", envName: "SMOKE_KEY" });
if (!added.ok) throw new Error(`adding the secret: ${added.error}`);
const withSecrets = new RemoteExecutionEnv({ connection, id: "machine:smoke", cwd: workspace, shellEnv: await secrets.shellEnv() });
out = "";
await withSecrets.exec(
	[
		"curl -sS -o /dev/null -w 'curl %{http_code}\\n' https://httpbin.org/basic-auth/imp/smoke-pass",
		`node -e "fetch('https://httpbin.org/basic-auth/imp/smoke-pass').then((r) => console.log('fetch', r.status))"`,
		"echo stand-in $SMOKE_KEY",
		`echo copies of the value: $( (grep -rl '${value}' ~ /proc/*/environ 2>/dev/null || true) | wc -l)`,
	].join("; "),
	{ onOutput: (text: string) => void (out += text) },
	BACKGROUND_CONTEXT,
);
lap(`egress:\n${out.trim()}\nuses: ${JSON.stringify(secrets.state().uses)}`);
secrets.close();

// The screen answers with the VNC (RFB) server's greeting, such as "RFB 003.008".
const screen = await machine.screen();
const vnc = new WebSocket(screen.url, { headers: { ...screen.headers } });
const greeting = await new Promise<string>((resolve, reject) => {
	vnc.once("message", (data) => resolve(String(data).trim()));
	vnc.once("close", (code, reason) => reject(new Error(`the screen closed (${code}): ${reason}`)));
	vnc.once("error", reject);
});
lap(`screen: ${greeting}`);
vnc.close();


connection.close();
process.exit(0);

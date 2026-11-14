// Smoke test for a machine adapter: prepare the image, ensure the machine, reach it through pi-env, run a command,
// write and read a file, load an app on the app socket and call one of its operations, use a secret through the egress
// proxy, and reach the screen.
//
//   MACHINE=e2b node scripts/smoke-machine.ts                      (needs E2B_API_KEY; MACHINE_CPUS, MACHINE_MEMORY_MB)
//   MACHINE=ssh MACHINE_SSH=imp@homelab[:port] [MACHINE_SSH_KEY=~/.ssh/key] node scripts/smoke-machine.ts
//   MACHINE=local node scripts/smoke-machine.ts
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry } from "@earendil-works/pi-durable";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { type RawData, WebSocket } from "ws";
import { Topics } from "../src/live.ts";
import type { MachineProvider } from "../src/machine.ts";
import { e2bProvider } from "../src/machine-e2b.ts";
import { localProvider } from "../src/machine-local.ts";
import { machineImage } from "../src/machine-runtime.ts";
import { sshProvider } from "../src/machine-ssh.ts";
import {
  type FromAgentd,
  fromAgentdCheck,
  type ToAgentd,
} from "../src/protocol.ts";
import { openSecrets } from "../src/secrets.ts";

const started = Date.now();

const lap = (label: string) => {
  console.log(`${((Date.now() - started) / 1000).toFixed(1)}s ${label}`);
};

const secret = "smoke-test-secret";
const { MACHINE = "e2b", MACHINE_SSH = "", MACHINE_SSH_KEY } = process.env;

const providers = new Map<string, () => MachineProvider>([
  ["e2b", () => e2bProvider({ secret })],
  [
    "ssh",
    () =>
      sshProvider({
        secret,
        target: MACHINE_SSH,
        identityFile: MACHINE_SSH_KEY,
      }),
  ],
  [
    "local",
    () => localProvider({ secret, dir: path.join(tmpdir(), "imp-smoke") }),
  ],
]);

const createProvider = providers.get(MACHINE);

if (!createProvider) {
  throw new Error(
    `MACHINE must be one of ${[...providers.keys()].join(", ")}, not ${MACHINE}`
  );
}

const provider = createProvider();

const size = {
  cpus: Number(process.env.MACHINE_CPUS ?? 2),
  memoryMB: Number(process.env.MACHINE_MEMORY_MB ?? 4096),
};

const image = await provider.prepareImage(await machineImage(size));

lap(`image ${image} prepared on ${provider.name}`);

const machine = await provider.ensure({
  key: "smoke:test",
  image,
  idleSuspendMs: 5 * 60_000,
});

lap("machine ensured");

const connection = new Connection({
  command: async () => await machine.daemonCommand(),
});

const info = await connection.info();

lap(`pi-env hello: ${info.os}/${info.arch} v${info.version}, cwd ${info.cwd}`);

const workspace = provider.workspace("smoke:test");

const env = new RemoteExecutionEnv({
  connection,
  id: "machine:smoke",
  cwd: workspace,
});

let out = "";

const result = await env.exec(
  "uname -a && node -v && cat /var/lib/imp/setup && echo hello-from-machine",
  {
    onOutput: (text: string) => {
      out += text;
    },
  },
  BACKGROUND_CONTEXT
);

lap(
  `exec ${JSON.stringify(result.ok ? { exitCode: result.value.exitCode } : result.error)}:\n${out.trim()}`
);

await env.writeFile(
  `${workspace}/smoke.txt`,
  "written through pi-env\n",
  BACKGROUND_CONTEXT
);

const back = await env.readTextFile(
  `${workspace}/smoke.txt`,
  BACKGROUND_CONTEXT
);

lap(
  `file round trip: ${back.ok ? back.value.trim() : JSON.stringify(back.error)}`
);

const text = (frame: RawData) => {
  if (Buffer.isBuffer(frame)) {
    return frame.toString("utf-8");
  }

  const bytes = Array.isArray(frame)
    ? Buffer.concat(frame)
    : Buffer.from(frame);

  return bytes.toString("utf-8");
};

/** The next frame `socket` receives, as text; fails when `what` closes or breaks first. */
const nextFrame = async (socket: WebSocket, what: string) =>
  await new Promise<string>((resolve, reject) => {
    socket.once("message", (frame) => {
      resolve(text(frame));
    });
    socket.once("close", (code, reason) => {
      reject(
        new Error(`${what} closed (${code}): ${reason.toString("utf-8")}`)
      );
    });
    socket.once("error", reject);
  });

const endpoint = await machine.appSocket();
const ws = new WebSocket(endpoint.url, { headers: { ...endpoint.headers } });

// Rejects when the socket fails before it opens.
await once(ws, "open");

const toAgentd = (message: ToAgentd) => {
  ws.send(JSON.stringify(message));
};

/** What agentd says next, checked against the protocol as the host checks it (src/app-machine.ts). */
const fromAgentd = async (): Promise<FromAgentd> => {
  const frame = await nextFrame(ws, "the app socket");
  const message: unknown = JSON.parse(frame);

  if (!fromAgentdCheck.check(message)) {
    throw new Error(
      `the app socket sent what is not in the protocol: ${frame}`
    );
  }

  return message;
};

const code =
  "export default { operations: { ping: { kind: 'read', description: 'Answers pong.', params: {}, run: () => 'pong' } } }";

toAgentd({ t: "load", app: "smoke", hash: "1", code });

lap(`app socket: ${JSON.stringify(await fromAgentd())}`);

toAgentd({ t: "call", id: "1", app: "smoke", name: "ping", args: {} });

lap(`app call: ${JSON.stringify(await fromAgentd())}`);

ws.close();

// A secret for httpbin.org's basic-auth check: the request from the machine gets 200 only with the real value, which
// the host's egress proxy adds; the machine holds only the stand-in, in its environment and nowhere else.
const value = Buffer.from("imp:smoke-pass").toString("base64");

const secrets = openSecrets({
  dataDir: mkdtempSync(path.join(tmpdir(), "imp-smoke-secrets-")),
  toolsDir: path.join(tmpdir(), "imp-tools"),
  topics: new Topics(),
  registry: createRegistry(),
  machine: async () => machine,
});

const added = await secrets.put({
  name: "smoke",
  service: "other",
  value,
  hosts: "httpbin.org",
  header: "Authorization",
  prefix: "Basic ",
  envName: "SMOKE_KEY",
});

if (!added.ok) {
  throw new Error(`adding the secret: ${added.error}`);
}

const withSecrets = new RemoteExecutionEnv({
  connection,
  id: "machine:smoke",
  cwd: workspace,
  shellEnv: await secrets.shellEnv(),
});

out = "";

await withSecrets.exec(
  [
    "curl -sS -o /dev/null -w 'curl %{http_code}\\n' https://httpbin.org/basic-auth/imp/smoke-pass",
    `node -e "fetch('https://httpbin.org/basic-auth/imp/smoke-pass').then((r) => console.log('fetch', r.status))"`,
    "echo stand-in $SMOKE_KEY",
    `echo copies of the value: $( (grep -rl '${value}' ~ /proc/*/environ 2>/dev/null || true) | wc -l)`,
  ].join("; "),
  {
    onOutput: (text: string) => {
      out += text;
    },
  },
  BACKGROUND_CONTEXT
);

lap(`egress:\n${out.trim()}\nuses: ${JSON.stringify(secrets.state().uses)}`);

secrets.close();

// The screen answers with the VNC (RFB) server's greeting, such as "RFB 003.008".
const screen = await machine.screen();
const vnc = new WebSocket(screen.url, { headers: { ...screen.headers } });
const greeting = await nextFrame(vnc, "the screen");

lap(`screen: ${greeting.trim()}`);

vnc.close();

connection.close();

process.exit(0);

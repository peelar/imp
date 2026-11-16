// Smoke test for a machine adapter: prepare the image, ensure the machine, reach it through pi-env, run a command,
// write and read a file, load an app on the app socket and call one of its operations, use a secret through the egress
// proxy, sign in to a test site in the machine's Chrome with a login the host types, and reach the screen.
//
//   MACHINE=e2b node scripts/smoke-machine.ts                      (needs E2B_API_KEY; MACHINE_CPUS, MACHINE_MEMORY_MB)
//   MACHINE=ssh MACHINE_SSH=imp@homelab[:port] [MACHINE_SSH_KEY=~/.ssh/key] node scripts/smoke-machine.ts
//   MACHINE=container node scripts/smoke-machine.ts                 (needs Docker, OrbStack or Podman on this machine)
//   MACHINE=local node scripts/smoke-machine.ts
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { Connection, RemoteExecutionEnv } from "@earendil-works/pi-env";
import { type RawData, WebSocket } from "ws";
import { Topics } from "../src/live/live.ts";
import type { MachineProvider } from "../src/machine/machine.ts";
import { containerProvider } from "../src/computer/container.ts";
import { e2bProvider } from "../src/computer/e2b.ts";
import { localProvider } from "../src/computer/local.ts";
import { machineImage } from "../src/computer/runtime.ts";
import { sshProvider } from "../src/computer/ssh.ts";
import {
  type FromAgentd,
  fromAgentdCheck,
  type ToAgentd,
} from "../src/apps/protocol.ts";
import { openSecrets } from "../src/secrets/secrets.ts";

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
  ["container", () => containerProvider({ secret })],
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

/** What agentd says next, checked against the protocol as the host checks it (src/apps/socket.ts). */
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

// `probe` reports what app code reaches: whether it sees agentd's token, and what agentd's egress proxy (see below)
// answers its request without the proxy password.
const code = `import net from "node:net";
export default { operations: {
  ping: { kind: "read", description: "Answers pong.", params: {}, run: () => "pong" },
  probe: { kind: "read", description: "What app code reaches.", params: { port: { type: "integer" } }, run: ({ port }) =>
    new Promise((resolve) => {
      const proxy = net.connect(port, "127.0.0.1", () => proxy.write("CONNECT httpbin.org:443 HTTP/1.1\\r\\nHost: httpbin.org:443\\r\\n\\r\\n"));
      proxy.once("data", (data) => { proxy.destroy(); resolve({ token: "AGENTD_TOKEN" in process.env, proxy: data.toString().split("\\r\\n")[0] }); });
      proxy.once("error", (error) => resolve({ error: error.message }));
    }) },
} };`;

toAgentd({ t: "load", app: "smoke", hash: "1", code });

lap(`app socket: ${JSON.stringify(await fromAgentd())}`);

toAgentd({ t: "call", id: "1", app: "smoke", name: "ping", args: {} });

lap(`app call: ${JSON.stringify(await fromAgentd())}`);

// A secret for httpbin.org's basic-auth check: the request from the machine gets 200 only with the real value, which
// the host's egress proxy adds; the machine holds only the stand-in, in its environment and nowhere else.
const value = Buffer.from("imp:smoke-pass").toString("base64");

const registry = createRegistry();

const secrets = openSecrets({
  dataDir: mkdtempSync(path.join(tmpdir(), "imp-smoke-secrets-")),
  toolsDir: path.join(tmpdir(), "imp-tools"),
  topics: new Topics(),
  registry,
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
    `node -e "require('https').get('https://httpbin.org/basic-auth/imp/smoke-pass', (r) => { console.log('https', r.statusCode); process.exit(); })"`,
    "curl -sS -o /dev/null -w 'another host %{http_code}\\n' https://example.com",
    // The proxy password is in HTTPS_PROXY; without it the proxy refuses the request (407).
    `curl -sS -o /dev/null -w 'no password %{http_connect}\\n' --proxy "http://\${HTTPS_PROXY#*@}" https://httpbin.org/get 2>/dev/null`,
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

// App code has neither agentd's token nor the proxy password, so the proxy refuses it too.
const proxyPort = Number(
  new URL((await machine.egress()).env.HTTPS_PROXY ?? "").port
);

toAgentd({
  t: "call",
  id: "2",
  app: "smoke",
  name: "probe",
  args: { port: proxyPort },
});

lap(`app code: ${JSON.stringify(await fromAgentd())}`);

ws.close();

// A login for a public test site: the agent opens its sign-in page with agent-browser, and the host types the login
// into that browser over DevTools; the site's next page is its members' area, /secure, which the agent's own
// agent-browser session then shows.
const login = await secrets.putLogin({
  name: "internet",
  site: "the-internet.herokuapp.com",
  username: "tomsmith",
  password: "SuperSecretPassword!",
  otp: "",
});

if (!login.ok) {
  throw new Error(`adding the login: ${login.error}`);
}

out = "";

await env.exec(
  "agent-browser open https://the-internet.herokuapp.com/login 2>&1 | tail -1",
  {
    onOutput: (text: string) => {
      out += text;
    },
  },
  BACKGROUND_CONTEXT
);

const signIn = registry
  .snapshot()
  .extension("secrets")
  ?.tools?.find((tool) => tool.name === "sign_in");

if (!signIn) {
  throw new Error("the secrets extension has no sign_in tool");
}

// SAFETY: secrets/tools.ts's sign_in reads only its arguments: it never touches the harness's API.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the smoke test runs the tool without a harness.
const noHarness = {} as ToolExecutionApi;

const typed = await signIn.execute(
  { secret: "internet" },
  noHarness,
  BACKGROUND_CONTEXT
);

const [answer] = typed.output ?? [];

lap(`sign in: ${out.trim()}\n${answer?.type === "text" ? answer.text : ""}`);

out = "";

await env.exec(
  "echo agent-browser is on $(agent-browser get url 2>&1 | tail -1); agent-browser close >/dev/null 2>&1",
  {
    onOutput: (text: string) => {
      out += text;
    },
  },
  BACKGROUND_CONTEXT
);

lap(out.trim());

secrets.close();

// The screen answers with the VNC (RFB) server's greeting, such as "RFB 003.008".
const screen = await machine.screen();
const vnc = new WebSocket(screen.url, { headers: { ...screen.headers } });
const greeting = await nextFrame(vnc, "the screen");

lap(`screen: ${greeting.trim()}`);

vnc.close();

connection.close();

process.exit(0);

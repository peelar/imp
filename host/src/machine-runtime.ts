// The machine runtime and setup: what the host puts on every machine, whatever the provider. The setup script
// (machine/setup.sh) installs the system packages once per version; the runtime is one agentd process that serves
// pi-env, the app daemon and the screen on one port (see machine/agentd.mjs). Adapters run the setup, copy the runtime files,
// start agentd, and check its health; nothing here depends on the provider.
import { createHash, createHmac } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { packagedDaemon } from "@earendil-works/pi-env";
import type { ImageSpec, MachineSize } from "./machine.ts";

const here = import.meta.dirname;
const require = createRequire(import.meta.url);
const MACHINE_SOURCES = join(here, "..", "machine");
const WS_PACKAGE = dirname(require.resolve("ws/package.json"));
const BRIDGE_CLIENT = join(here, "bridge-client.mjs");

export const AGENTD_PORT = 7070;

/** Where a machine records the digest of the setup it last ran. */
export const SETUP_MARKER = "/var/lib/imp/setup";

/** The image every machine gets: this host's setup script, at `size` where the provider lets us choose. */
export async function machineImage(size: MachineSize): Promise<ImageSpec> {
  return {
    setup: await readFile(join(MACHINE_SOURCES, "setup.sh"), "utf-8"),
    size,
  };
}

/**
 * The setup as one root shell script that records its digest in SETUP_MARKER once it succeeded, so an adapter runs it
 * only on a machine whose marker differs.
 */
export function setupScript(setup: string): { digest: string; script: string } {
  const digest = createHash("sha256").update(setup).digest("hex").slice(0, 16);

  return {
    digest,
    script: `${setup}\nmkdir -p ${dirname(SETUP_MARKER)} && echo ${digest} > ${SETUP_MARKER}\n`,
  };
}

export type Runtime = {
  readonly files: readonly RuntimeFile[];
  /** Changes whenever any file does. */
  readonly digest: string;
};

export type RuntimeFile = {
  /** Relative to the runtime directory on the machine. */
  readonly path: string;
  readonly data: Buffer;
  readonly executable?: boolean;
};

/** A `pkill -f` pattern for every process started from `runtimeDir`, which never matches the shell running pkill. */
export const runtimePattern = (runtimeDir: string) =>
  `${runtimeDir.slice(0, -1)}[${runtimeDir.slice(-1)}]/`;

/** Every file agentd needs, for a machine of this platform. */
export async function runtime(platform: {
  platform: "linux" | "darwin";
  arch: "x64" | "arm64";
}): Promise<Runtime> {
  const files: RuntimeFile[] = [
    {
      path: "pi-env",
      data: await readFile(packagedDaemon(platform)),
      executable: true,
    },
    {
      path: "agentd.mjs",
      data: await readFile(join(MACHINE_SOURCES, "agentd.mjs")),
    },
    {
      path: "worker.mjs",
      data: await readFile(join(MACHINE_SOURCES, "worker.mjs")),
    },
    {
      path: "screen.sh",
      data: await readFile(join(MACHINE_SOURCES, "screen.sh")),
    },
  ];

  for (const file of await listFiles(WS_PACKAGE)) {
    files.push({
      path: `node_modules/ws/${relative(WS_PACKAGE, file)}`,
      data: await readFile(file),
    });
  }

  const hash = createHash("sha256");

  for (const file of files) {
    hash.update(file.path).update("\0").update(file.data).update("\0");
  }

  return { files, digest: hash.digest("hex").slice(0, 16) };
}

/** The environment agentd starts with. */
export function agentdEnv(options: {
  token: string;
  digest: string;
  runtimeDir: string;
  home: string;
  host?: string;
}) {
  return {
    AGENTD_TOKEN: options.token,
    AGENTD_DIGEST: options.digest,
    AGENTD_PORT: String(AGENTD_PORT),
    PI_ENV_PATH: join(options.runtimeDir, "pi-env"),
    MACHINE_HOME: options.home,
    ...(options.host ? { AGENTD_HOST: options.host } : {}),
  };
}

/** Where agentd keeps the egress proxy's CA certificate, and a CA bundle with it added. */
const egressDir = (home: string) => join(home, ".cache", "imp");

/**
 * What a command needs on the machine for its HTTPS requests to go through agentd's egress proxy, where the host puts
 * the owner's secrets on them: the proxy, and the host's CA certificate, which the proxy's TLS is signed with.
 */
export function egressEnv(home: string, port = EGRESS_PORT): Record<string, string> {
	const proxy = `http://127.0.0.1:${port}`;
	const noProxy = "localhost,127.0.0.1,::1";
	const bundle = join(egressDir(home), "ca-bundle.pem");
	return {
		HTTPS_PROXY: proxy,
		https_proxy: proxy,
		NO_PROXY: noProxy,
		no_proxy: noProxy,
		// Node's fetch and https use the proxy only when asked to.
		NODE_USE_ENV_PROXY: "1",
		NODE_EXTRA_CA_CERTS: join(egressDir(home), "egress-ca.pem"),
		// OpenSSL, Python, curl, git and Go read these instead of the system bundle; agentd's bundle is that plus the CA.
		SSL_CERT_FILE: bundle,
		REQUESTS_CA_BUNDLE: bundle,
		CURL_CA_BUNDLE: bundle,
		GIT_SSL_CAINFO: bundle,
	};
}

/** Each machine's token: derived from the host secret, so the host needs to store nothing per machine. */
export const agentdToken = (secret: string, machineId: string) =>
  createHmac("sha256", secret).update(`agentd:${machineId}`).digest("hex");

/** What a healthy agentd started with `token` and this runtime answers on /health. */
export const healthFor = (token: string, digest: string) =>
  createHash("sha256").update(`${token}:${digest}`).digest("hex");

/** The endpoints every machine offers, given the base URL that reaches agentd's port. */
export function agentdEndpoints(
  base: { url: string; headers: Readonly<Record<string, string>> },
  token: string
) {
  const ws = base.url.replace(/^http/, "ws");

  return {
    /** pi-env's Connection appends `serve --token <hex>` to this command. */
    daemonCommand: [
      process.execPath,
      BRIDGE_CLIENT,
      `${ws}/pi-env?token=${token}`,
      JSON.stringify(base.headers),
    ],
    appSocket: { url: `${ws}/apps?token=${token}`, headers: base.headers },
    screen: { url: `${ws}/screen?token=${token}`, headers: base.headers },
  };
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      out.push(...(await listFiles(path)));
    } else {
      out.push(path);
    }
  }

  return out;
}

// The machine runtime and setup: what the host puts on every machine, whatever the provider. The setup script
// (machine/setup.sh) installs the system packages once per version; the runtime is one agentd process that serves
// pi-env, the app daemon and the screen on one port (see machine/agentd.ts). Adapters run the setup, copy the runtime
// files, start agentd, and check its health; nothing here depends on the provider.
import { createHash, createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire, stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { packagedDaemon } from "@earendil-works/pi-env";
import type { ImageSpec, MachineSize } from "../machine/machine.ts";

const here = import.meta.dirname;
const require = createRequire(import.meta.url);
const MACHINE_SOURCES = path.join(here, "..", "..", "machine");
const WS_PACKAGE = path.dirname(require.resolve("ws/package.json"));
const BRIDGE_CLIENT = path.join(here, "bridge-client.ts");

export const AGENTD_PORT = 7070;

/** Where agentd takes the agent's HTTPS requests that may need a secret (secrets/egress.ts), on the machine's loopback. */
export const EGRESS_PORT = 7071;

/** Where a machine records the digest of the setup it last ran. */
export const SETUP_MARKER = "/var/lib/imp/setup";

/** The image every machine gets: this host's setup script, at `size` where the provider lets us choose. */
export async function machineImage(size: MachineSize): Promise<ImageSpec> {
  return {
    setup: await readFile(path.join(MACHINE_SOURCES, "setup.sh"), "utf-8"),
    size,
  };
}

/**
 * The setup as one root shell script that records its digest in SETUP_MARKER once it succeeded, so an adapter runs it
 * only on a machine whose marker differs.
 */
export function setupScript(setup: string) {
  const digest = createHash("sha256").update(setup).digest("hex").slice(0, 16);

  return {
    digest,
    script: `${setup}\nmkdir -p ${path.dirname(SETUP_MARKER)} && echo ${digest} > ${SETUP_MARKER}\n`,
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
  readonly executable?: true;
};

/** A `pkill -f` pattern for every process started from `runtimeDir`, which never matches the shell running pkill. */
export const runtimePattern = (runtimeDir: string) =>
  `${runtimeDir.slice(0, -1)}[${runtimeDir.slice(-1)}]/`;

/**
 * Every file agentd needs, for a machine of this platform. The machine runs plain JavaScript with no packages but
 * ws, so agentd, the worker, the egress proxy and the Chrome bridge ship with their types stripped.
 */
export async function runtime(platform: {
  platform: "linux" | "darwin";
  arch: "x64" | "arm64";
}): Promise<Runtime> {
  const wsFiles = await listFiles(WS_PACKAGE);

  const files: RuntimeFile[] = await Promise.all([
    readFile(packagedDaemon(platform)).then((data): RuntimeFile => ({
      path: "pi-env",
      data,
      executable: true,
    })),
    stripped("agentd"),
    stripped("worker"),
    stripped("egress"),
    stripped("chrome"),
    shipped("screen.sh", path.join(MACHINE_SOURCES, "screen.sh")),
    ...wsFiles.map(
      async (file) =>
        await shipped(
          `node_modules/ws/${path.relative(WS_PACKAGE, file)}`,
          file
        )
    ),
  ]);

  const hash = createHash("sha256");

  for (const file of files) {
    hash.update(file.path).update("\0").update(file.data).update("\0");
  }

  return { files, digest: hash.digest("hex").slice(0, 16) };
}

/**
 * Writes the runtime's files under `dir` on this computer, for an adapter that runs agentd from there or packs the
 * directory to send it.
 */
export async function writeRuntime(
  files: readonly RuntimeFile[],
  dir: string
): Promise<void> {
  await Promise.all(
    files.map(async (file) => {
      const to = path.join(dir, file.path);

      await mkdir(path.dirname(to), { recursive: true });
      await writeFile(to, file.data);

      if (file.executable) {
        await chmod(to, 0o755);
      }
    })
  );
}

/** Everything under `dir` on this computer, as one tar archive. */
async function packed(dir: string): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    execFile(
      "tar",
      ["-C", dir, "-cf", "-", "."],
      { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          // Node's own description of the failure, which names the command and carries what it printed.
          reject(new Error(error.message, { cause: error }));
        } else {
          resolve(stdout);
        }
      }
    );
  });
}

/** The runtime's files as one tar archive, for an adapter that unpacks it on the machine. */
export async function packedRuntime(
  files: readonly RuntimeFile[]
): Promise<Buffer> {
  const staging = await mkdtemp(path.join(tmpdir(), "imp-runtime-"));

  try {
    await writeRuntime(files, staging);

    return await packed(staging);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

const shipped = async (to: string, from: string): Promise<RuntimeFile> => ({
  path: to,
  data: await readFile(from),
});

/** machine/<name>.ts as <name>.mjs: its types stripped, and its imports of the other machine files renamed with them. */
const stripped = async (name: string): Promise<RuntimeFile> => ({
  path: `${name}.mjs`,
  data: Buffer.from(
    stripTypeScriptTypes(
      await readFile(path.join(MACHINE_SOURCES, `${name}.ts`), "utf-8"),
      { mode: "strip" }
    ).replaceAll(/(from "\.\/[\w-]+)\.ts"/g, '$1.mjs"')
  ),
});

/** The environment agentd starts with. `host` is the address it listens on, when not every address. */
export function agentdEnv(options: {
  token: string;
  digest: string;
  runtimeDir: string;
  home: string;
  host?: string | undefined;
  /** Where the egress proxy listens, when machines share a loopback and each takes a free port. */
  egressPort?: number | undefined;
}) {
  const env = {
    AGENTD_TOKEN: options.token,
    AGENTD_DIGEST: options.digest,
    AGENTD_PORT: String(AGENTD_PORT),
    PI_ENV_PATH: path.join(options.runtimeDir, "pi-env"),
    MACHINE_HOME: options.home,
    EGRESS_PORT: String(options.egressPort ?? EGRESS_PORT),
    EGRESS_DIR: egressDir(options.home),
  };

  return options.host === undefined
    ? env
    : { ...env, AGENTD_HOST: options.host };
}

/** Where agentd keeps the egress proxy's CA certificate, and a CA bundle with it added. */
const egressDir = (home: string) => path.join(home, ".cache", "imp");

/**
 * What a command needs on the machine for its HTTPS requests to go through agentd's egress proxy, where the host puts
 * the owner's secrets on them: the proxy, and the host's CA certificate, which the proxy's TLS is signed with.
 */
export function egressEnv(home: string, port = EGRESS_PORT) {
  const proxy = `http://127.0.0.1:${port}`;
  const noProxy = "localhost,127.0.0.1,::1";
  const bundle = path.join(egressDir(home), "ca-bundle.pem");

  return {
    HTTPS_PROXY: proxy,
    https_proxy: proxy,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    // Node's fetch and https use the proxy only when asked to.
    NODE_USE_ENV_PROXY: "1",
    NODE_EXTRA_CA_CERTS: path.join(egressDir(home), "egress-ca.pem"),
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
    /** Chrome's DevTools protocol on the machine (its browser target). */
    chrome: { url: `${ws}/chrome?token=${token}`, headers: base.headers },
    /** The egress proxy's control socket; a stream socket adds `&stream=<id>`. */
    egress: { url: `${ws}/egress?token=${token}`, headers: base.headers },
  };
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });

  const nested = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(dir, entry.name);

      return entry.isDirectory() ? await listFiles(file) : [file];
    })
  );

  return nested.flat();
}

// mitmproxy on the host's loopback: the part of the egress proxy that ends TLS with Imp's own CA, and whose addon
// (egress/inject.py) puts a secret on a request and takes it out of the response. The host starts it the first time
// a command needs it, keeps its rules and its vault token on disk for the addon, and records the uses it prints.
//
//   DATA_DIR/egress/ca/        mitmproxy's CA (its private key never leaves the host)
//   DATA_DIR/egress/rules.json which secret goes on which host's requests, and their stand-ins: names, no values
//   DATA_DIR/egress/token      a vault token that only reads values, replaced every half hour
import { type ChildProcess, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { compile, int, obj, opt, str } from "@earendil-works/pi-schema";
import { killOnExit, lastLines } from "../kernel/children.ts";
import { accepts, freePort } from "../kernel/ports.ts";
import { tool } from "./programs.ts";
import type { Vault } from "./vault.ts";

const ADDON = path.join(import.meta.dirname, "..", "..", "egress", "inject.py");
const TOKEN_ROTATE_MS = 30 * 60_000;
const USE_MARK = "IMP-USE ";

/** One header a secret is put in, on requests to one host. */
export type EgressRule = {
  readonly secret: string;
  readonly header: string;
  /** Written before the value, such as "Bearer ". */
  readonly prefix: string;
  /** Set for HTTP basic auth: the value goes in as base64 of `<basicUser>:<value>`. */
  readonly basicUser?: string | undefined;
};

export type EgressRules = {
  readonly hosts: Readonly<Record<string, readonly EgressRule[]>>;
  readonly standIns: Readonly<Record<string, string>>;
};

const use = compile(
  obj({
    secret: str(),
    method: str(),
    host: str(),
    path: str(),
    status: int(),
    error: str(),
    app: opt(str()),
  })
);

/** One use of a secret, as the addon reports it. */
export type EgressUse = {
  readonly secret: string;
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly status: number;
  readonly error: string;
  /** The app the host sent it for; absent or "" for the imp's own. */
  readonly app?: string | undefined;
};

export type MitmProxyOptions = {
  /** DATA_DIR/egress. */
  readonly dir: string;
  readonly toolsDir: string;
  readonly vault: Vault;
  readonly onUse: (use: EgressUse) => void;
};

type Running = { readonly child: ChildProcess; readonly port: number };

/** Writes a file whole: the addon never reads half of one. */
function writeAtomic(file: string, content: string) {
  writeFileSync(`${file}.tmp`, content, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** The use a line of the addon's output reports; undefined for a line that reports none. */
function reportedUse(line: string): EgressUse | undefined {
  const at = line.indexOf(USE_MARK);

  if (at === -1) {
    return undefined;
  }

  try {
    const reported: unknown = JSON.parse(line.slice(at + USE_MARK.length));

    return use.check(reported) ? reported : undefined;
  } catch {
    return undefined;
  }
}

/** Reads mitmproxy's output line by line: a use goes to `onUse`, anything else it says goes to the log. */
function followOutput(
  stdout: Readable,
  { onUse, log }: { onUse: (use: EgressUse) => void; log: string }
) {
  let pending = "";

  stdout.setEncoding("utf-8");
  stdout.on("data", (chunk: string) => {
    const lines = `${pending}${chunk}`.split("\n");

    pending = lines.pop() ?? "";

    for (const line of lines) {
      const reported = reportedUse(line);

      if (reported) {
        onUse(reported);
      } else if (line.trim()) {
        appendFileSync(log, `${line}\n`);
      }
    }
  });
}

type Launch = {
  readonly mitmdump: string;
  readonly port: number;
  readonly dir: string;
  readonly caDir: string;
  readonly vaultSocket: string;
};

/** Starts mitmproxy on `port` with the addon, knowing the vault only by its socket. */
function launch({ mitmdump, port, dir, caDir, vaultSocket }: Launch) {
  const child = spawn(
    mitmdump,
    [
      "--mode",
      `regular@127.0.0.1:${port}`,
      "--set",
      `confdir=${caDir}`,
      // Large bodies (downloads, git packs) stream through; only buffered ones are scrubbed of a value.
      "--set",
      "stream_large_bodies=1m",
      "--set",
      "termlog_verbosity=warn",
      "--set",
      "flow_detail=0",
      "-s",
      ADDON,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: dir,
        IMP_EGRESS_DIR: dir,
        IMP_VAULT_SOCKET: vaultSocket,
      },
    }
  );

  killOnExit(child);

  return child;
}

/**
 * The addon's vault token, which only reads values: a new one every half hour once started, each written where the
 * addon reads it, and the one it replaces revoked a minute later.
 */
function addonToken(file: string, vault: Vault) {
  let rotation: NodeJS.Timeout | undefined;
  let accessor = "";

  const rotate = async () => {
    const previous = accessor;
    const next = await vault.egressToken();

    writeAtomic(file, next.token);
    ({ accessor } = next);

    if (previous) {
      setTimeout(() => {
        vault.revoke(previous).catch(() => {
          // It stays valid until it expires, within the hour.
        });
      }, 60_000).unref();
    }
  };

  return {
    /** Writes a token now, and keeps replacing it. */
    start: async () => {
      await rotate();
      rotation ??= setInterval(() => {
        rotate().catch((cause: unknown) => {
          console.error(
            `egress token: ${cause instanceof Error ? cause.message : String(cause)}`
          );
        });
      }, TOKEN_ROTATE_MS);
      rotation.unref();
    },
    stop: () => {
      if (rotation) {
        clearInterval(rotation);
      }
    },
  };
}

export type MitmProxy = ReturnType<typeof mitmProxy>;

export function mitmProxy(options: MitmProxyOptions) {
  const { dir, vault } = options;
  const caDir = path.join(dir, "ca");
  const certificate = path.join(caDir, "mitmproxy-ca-cert.pem");
  const log = path.join(dir, "mitmdump.log");
  const token = addonToken(path.join(dir, "token"), vault);
  let rules: EgressRules = { hosts: {}, standIns: {} };
  let proxy: Running | undefined;
  let starting: Promise<Running> | undefined;
  let closed = false;

  mkdirSync(caDir, { recursive: true, mode: 0o700 });

  const writeRules = () => {
    writeAtomic(path.join(dir, "rules.json"), JSON.stringify(rules));
  };

  const start = async (): Promise<Running> => {
    const mitmdump = await tool(options.toolsDir, "mitmdump");

    await vault.ready();
    writeRules();
    await token.start();
    const port = await freePort();
    const { socket: vaultSocket } = vault;
    const child = launch({ mitmdump, port, dir, caDir, vaultSocket });

    followOutput(child.stdout, { onUse: options.onUse, log });
    child.stderr.on("data", (chunk: Buffer) => {
      appendFileSync(log, chunk);
    });
    child.on("exit", (code) => {
      if (proxy?.child === child) {
        proxy = undefined;
      }

      if (!closed) {
        appendFileSync(log, `mitmdump exited (${String(code)})\n`);
      }
    });

    for (let tries = 0; tries < 300; tries += 1) {
      if (child.exitCode !== null) {
        break;
      }

      // oxlint-disable-next-line no-await-in-loop -- a poll: each try waits for the one before it.
      if (existsSync(certificate) && (await accepts(port))) {
        return { child, port };
      }

      // oxlint-disable-next-line no-await-in-loop -- the pause between two tries.
      await sleep(100);
    }

    child.kill();
    const tail = existsSync(log) ? lastLines(readFileSync(log, "utf-8")) : "";

    throw new Error(`The egress proxy did not start. ${tail}`);
  };

  /** One start, shared by everyone who waits for it. */
  const startOnce = async () => {
    try {
      proxy = await start();

      return proxy;
    } finally {
      starting = undefined;
    }
  };

  return {
    /** mitmproxy, running: started if it is not. */
    running: async () => {
      if (closed) {
        throw new Error("The egress proxy is closed.");
      }

      if (proxy && proxy.child.exitCode === null) {
        return proxy;
      }

      starting ??= startOnce();

      return await starting;
    },
    /** The host names a secret goes to. */
    hosts: () => Object.keys(rules.hosts),
    /** The certificate of the CA mitmproxy signs with, which it made on its first start. */
    caCertificate: () => readFileSync(certificate, "utf-8"),
    /** New rules: the addon reads them at once. */
    setRules: (next: EgressRules) => {
      rules = next;

      if (proxy || starting) {
        writeRules();
      }
    },
    close: () => {
      closed = true;
      token.stop();
      proxy?.child.kill();
    },
  };
}

// The OpenBao server the host runs and owns: the process, the host's sign-in to it, and the requests the host makes
// as itself. OpenBao takes requests on a unix socket only the host's user can open. Its storage (Raft) also needs a
// TCP cluster listener, so it listens on two loopback ports too, chosen once and kept: every request there still
// needs a token.
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { type OutgoingHttpHeaders, request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import {
  arr,
  compile,
  obj,
  str,
  type Validator,
} from "@earendil-works/pi-schema";
import type { Json } from "../../sdk/app.ts";
import { killOnExit, lastLines } from "./children.ts";
import { tool } from "./tools.ts";
import { prepare, type VaultFiles, vaultFiles } from "./vault-files.ts";

export type VaultServerOptions = {
  /** DATA_DIR/vault. */
  readonly dir: string;
  /** Where downloaded programs are kept (tools.ts). */
  readonly toolsDir: string;
};

type BaoRequest = {
  readonly socket: string;
  readonly method: string;
  readonly path: string;
  readonly body?: Json | undefined;
  /** "" for a request that needs none. */
  readonly token: string;
};

/** What OpenBao answered: its status and the body as text ("" for none). */
type BaoAnswer = { readonly status: number; readonly text: string };

const signedIn = compile(
  obj({ auth: obj({ client_token: str() }, { open: true }) }, { open: true })
);

const refusal = compile(obj({ errors: arr(str()) }, { open: true }));

/** `text` as JSON; undefined when it is not JSON. */
const parsed = (text: string) => {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    // Not JSON: no value.
  }

  return value;
};

/** What an answer of OpenBao's says, which must be `expected`: `what` names it in the error when it is not. */
export function answered<T>(
  expected: Validator<T>,
  text: string,
  what: string
): T {
  const answer = expected.validate(parsed(text));

  if (!answer.ok) {
    const problems = answer.errors.map(
      (error) => `${error.path || "the answer"}: ${error.message}`
    );

    throw new Error(
      `OpenBao's answer for ${what} is not one the host can read: ${problems.join("; ")}`
    );
  }

  return answer.value;
}

/** One request to OpenBao's API on its socket. */
async function send(sent: BaoRequest): Promise<BaoAnswer> {
  const payload =
    sent.body === undefined ? undefined : JSON.stringify(sent.body);

  const headers: OutgoingHttpHeaders = {};

  if (sent.token) {
    headers["x-vault-token"] = sent.token;
  }

  if (payload) {
    headers["content-type"] = "application/json";
  }

  return await new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: sent.socket,
        method: sent.method,
        path: `/v1/${sent.path}`,
        headers,
        timeout: 30_000,
      },
      (res) => {
        let text = "";

        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, text });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("OpenBao did not answer"));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

/** Why OpenBao refused a request: the errors it listed, else what it wrote, else its status. */
function refusalReason({ status, text }: BaoAnswer) {
  const answer = parsed(text);
  const listed = refusal.check(answer) ? answer.errors.join("; ") : "";
  const written = answer === undefined ? text : "";

  return listed || written || `status ${status}`;
}

/** Starts OpenBao from its configuration, with what it prints appended to its log. */
function spawnBao(bao: string, files: { config: string; log: string }) {
  appendFileSync(
    files.log,
    `\n--- ${new Date().toISOString()} starting OpenBao\n`
  );

  const child = spawn(bao, ["server", `-config=${files.config}`], {
    stdio: ["ignore", "pipe", "pipe"],
    // Only what it needs: OpenBao prints the names of the variables it sees.
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });

  killOnExit(child);

  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk: Buffer) => {
      appendFileSync(files.log, chunk);
    });
  }

  return child;
}

/** Signs the host in: its token, or "" when OpenBao does not take its password (yet). */
async function signIn(files: VaultFiles) {
  const answer = await send({
    socket: files.socket,
    method: "POST",
    path: "auth/userpass/login/host",
    body: { password: files.password() },
    token: "",
  });

  const said = parsed(answer.text);

  return signedIn.check(said) ? said.auth.client_token : "";
}

/** Whether OpenBao is unsealed and answers on its socket. */
async function unsealed(socket: string) {
  const health = await send({
    socket,
    method: "GET",
    path: "sys/health",
    token: "",
  });

  return health.status === 200;
}

const logTail = (log: string) =>
  existsSync(log) ? lastLines(readFileSync(log, "utf-8")) : "";

export type VaultServer = ReturnType<typeof vaultServer>;

export function vaultServer({ dir, toolsDir }: VaultServerOptions) {
  const files = vaultFiles(dir);
  let child: ChildProcess | undefined;
  let starting: Promise<void> | undefined;
  let token = "";
  let closed = false;
  let status = "stopped";
  let error = "";

  const login = async () => {
    token = await signIn(files);

    return token !== "";
  };

  /** Unsealed and set up: the host signs in, which needs self-initialization to have created its user. */
  const up = async () => {
    try {
      return (await unsealed(files.socket)) && (await login());
    } catch {
      // The socket is not there yet.
      return false;
    }
  };

  const start = async () => {
    status = "starting";
    error = "";
    const bao = await tool(toolsDir, "bao");

    await prepare(files);
    const started = spawnBao(bao, files);

    started.on("exit", (code) => {
      if (child !== started) {
        return;
      }

      child = undefined;
      token = "";

      if (!closed) {
        status = "failed";
        error = `OpenBao stopped (exit ${String(code)}). Its log is ${files.log}.`;
      }
    });
    child = started;

    for (let tries = 0; tries < 360; tries += 1) {
      // It exited: its exit handler has said why.
      if (child !== started) {
        break;
      }

      // oxlint-disable-next-line no-await-in-loop -- a poll: each try waits for the one before it.
      if (await up()) {
        status = "ready";

        return;
      }

      // oxlint-disable-next-line no-await-in-loop -- the pause between two tries.
      await sleep(250);
    }

    started.kill();

    throw new Error(`OpenBao did not start. ${logTail(files.log)}`);
  };

  /** One start, shared by everyone who waits for it; a failure is shown in `state` and the next call tries again. */
  const startOnce = async () => {
    try {
      await start();
    } catch (cause) {
      status = "failed";
      error = cause instanceof Error ? cause.message : String(cause);

      throw cause;
    } finally {
      starting = undefined;
    }
  };

  /** OpenBao, started if it is not running, with the host signed in. */
  const ready = async () => {
    if (closed) {
      throw new Error("The vault is closed.");
    }

    if (child && token) {
      return;
    }

    starting ??= startOnce();
    await starting;
  };

  return {
    /** "stopped", "starting", "ready", or "failed" (with `error`). */
    state: () => ({ status, error }),
    socket: files.socket,
    ready,
    /**
     * A request as the host, which signs in again once if its token has expired. Answers what OpenBao wrote, and
     * undefined for a 404.
     */
    request: async (method: string, path: string, body?: Json) => {
      await ready();
      const sent = { socket: files.socket, method, path, body };
      let answer = await send({ ...sent, token });

      if (answer.status === 403 && (await login())) {
        answer = await send({ ...sent, token });
      }

      if (answer.status >= 400 && answer.status !== 404) {
        throw new Error(
          `OpenBao refused ${method} ${path}: ${refusalReason(answer)}`
        );
      }

      return answer.status === 404 ? undefined : answer.text;
    },
    close: () => {
      closed = true;
      child?.kill();
      child = undefined;
    },
  };
}

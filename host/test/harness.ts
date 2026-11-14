// What the host's tests share: a test host (scripts/test-host.ts: a scripted model, a sign-in that approves itself,
// the local machine adapter) on a free port, so the apps run in real workers, and the two ways a client talks to it:
// live streams and calls.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { copyJson } from "@earendil-works/chord/json";
import type { Json } from "../../sdk/app.ts";

export type Row = { [name: string]: Json };

export const isRow = (value: Json | undefined): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPipe = (
  address: ReturnType<ReturnType<typeof createServer>["address"]>
): address is string => typeof address === "string";

export const repo = path.join(import.meta.dirname, "..", "..");

// A free port: the one the system gives a server that asks for any, which then closes.
const probe = createServer().listen(0, "127.0.0.1");

await once(probe, "listening");

const address = probe.address();

assert.ok(address !== null && !isPipe(address), "no port");

const { port } = address;

probe.close();

await once(probe, "close");

export const base = `http://127.0.0.1:${port}`;

// The test names the host's data directory, so it can start the host again on what the first one stored.
export const dataDir = mkdtempSync(path.join(tmpdir(), "imp-test-"));

/** Starts a test host process on the data directory; answers it once it listens. */
async function spawnTestHost() {
  const child = spawn(
    process.execPath,
    [path.join(repo, "host", "scripts", "test-host.ts")],
    {
      env: {
        ...process.env,
        PORT: String(port),
        TEST_SIGNIN_MS: "300",
        TEST_DATA_DIR: dataDir,
      },
      stdio: ["ignore", "pipe", "inherit"],
    }
  );

  const listening = Promise.withResolvers<undefined>();

  // Keep reading after the host listens: the machine runtime shares this pipe and stops when nobody reads it.
  child.stdout.on("data", (chunk: Buffer) => {
    if (chunk.toString("utf-8").includes("host on http://")) {
      listening.resolve(undefined);
    }
  });
  child.once("exit", () => {
    listening.reject(new Error("the test host exited before it listened"));
  });
  await listening.promise;

  return child;
}

let host: Awaited<ReturnType<typeof spawnTestHost>> | undefined;

/** Starts the test host, in place of the one that ran before, on the same port and data directory. */
export async function startTestHost() {
  await stopTestHost();
  host = await spawnTestHost();
}

/**
 * Waits for the host's vault. The agent's first command waits for OpenBao to start, which on a busy machine outlasts
 * a test's wait, so tests of the agent start once it is up.
 */
export async function vaultReady() {
  await until(
    "account",
    (answer) => {
      const secrets = isRow(answer) ? answer.secrets : undefined;

      return isRow(secrets) && secrets.status !== "starting"
        ? secrets
        : undefined;
    },
    120_000
  );
}

export async function stopTestHost() {
  if (host) {
    host.kill();
    await once(host, "exit");
    host = undefined;
  }
}

// The host answers JSON; the copy says so to the types, or throws.
const parseJson = (text: string): Json => copyJson(JSON.parse(text));

/**
 * The answers a live source sends, one per `data:` event, until the caller stops reading.
 *
 * @yields {Json} Each answer, as the JSON the host sent.
 */
async function* answers(
  source: string,
  signal: AbortSignal
): AsyncGenerator<Json> {
  const response = await fetch(`${base}/api/live/${source}?args=%5B%5D`, {
    signal,
  });

  assert.equal(response.status, 200, `live ${source}`);
  assert.ok(response.body);
  let buffered = "";

  for await (const chunk of response.body.pipeThrough(
    new TextDecoderStream()
  )) {
    buffered += chunk;
    const events = buffered.split("\n\n");
    buffered = events.pop() ?? "";

    for (const event of events) {
      if (event.startsWith("data: ")) {
        yield parseJson(event.slice("data: ".length));
      }
    }
  }
}

/** The first answer of a live source that `accept` takes, or a failure naming the last one seen. */
export async function until<T>(
  source: string,
  accept: (answer: Json) => T | undefined,
  timeoutMs = 10_000
): Promise<T> {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let last: Json | undefined;

  try {
    for await (const answer of answers(source, controller.signal)) {
      last = answer;
      const accepted = accept(answer);

      if (accepted !== undefined) {
        return accepted;
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      throw error;
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }

  throw new Error(
    `live ${source} never matched within ${timeoutMs} ms; last answer: ${JSON.stringify(last)}`
  );
}

export const first = async (source: string) =>
  await until(source, (answer) => answer);

export async function call(
  source: string,
  args: Json[]
): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${base}/api/call/${source}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });

  return { status: response.status, body: parseJson(await response.text()) };
}

/** What a mutation answers when it did what it was asked, and when it refused. */
export const done = { status: 200, body: { ok: true, error: "" } };

export const refused = (error: string) => ({
  ...done,
  body: { ok: false, error },
});

export const rows = (value: Json | undefined): Row[] =>
  Array.isArray(value) ? value.filter(isRow) : [];

/** A transcript row the person or the imp wrote: its words, and nothing of a tool call. */
export const said = (role: string, text: string) => ({
  role,
  text,
  title: "",
  detail: "",
  icon: "",
  failed: false,
});

/** A chat answer once the agent is between turns and `accept` takes its messages. */
export const settledChat =
  (accept: (messages: Row[]) => boolean) => (answer: Json) => {
    const messages =
      isRow(answer) && answer.busy === false
        ? rows(answer.messages)
        : undefined;

    return messages && accept(messages) ? messages : undefined;
  };

/**
 * Sends the agent a message that makes it call a tool, and answers the transcript's row for the call once the agent
 * is done: the message, that row and the model's "Done." are then the last three.
 */
export async function toolRow(message: string) {
  assert.deepEqual(await call("chatSend", [message, ""]), done);

  const messages = await until(
    "chat",
    settledChat((all) => all.at(-3)?.text === message),
    // A preview builds the shell, which takes minutes where Exact's build caches are cold.
    180_000
  );

  const { title, text, failed } = messages.at(-2) ?? {};

  return { title, text, failed };
}

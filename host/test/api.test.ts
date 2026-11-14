// The host's HTTP API, as the client uses it: live streams, calls, sign-in, the Todos app and the agent operating it.
// Starts the test host (scripts/test-host.ts: a scripted model, a sign-in that approves itself, the local machine
// adapter) on a free port, so the apps run in real workers. Run: npm test
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const freePort = async () =>
  await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port"));
      });
    });
  });

const port = await freePort();
const base = `http://127.0.0.1:${port}`;

const host = spawn(
  process.execPath,
  [join(import.meta.dirname, "..", "scripts", "test-host.ts")],
  {
    env: { ...process.env, PORT: String(port), TEST_SIGNIN_MS: "300" },
    stdio: ["ignore", "pipe", "inherit"],
  }
);

/** The answers a live source sends, one per `data:` event, until the caller stops reading. */
async function* answers(
  source: string,
  args: unknown[],
  signal: AbortSignal
): AsyncGenerator {
  const response = await fetch(
    `${base}/api/live/${source}?args=${encodeURIComponent(JSON.stringify(args))}`,
    { signal }
  );

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
        yield JSON.parse(event.slice("data: ".length));
      }
    }
  }
}

/** The first answer of a live source that `accept` takes, or a failure naming the last one seen. */
async function until<T>(
  source: string,
  accept: (answer: unknown) => T | undefined,
  timeoutMs = 10_000
): Promise<T> {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let last: unknown;

  try {
    for await (const answer of answers(source, [], controller.signal)) {
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

const first = async (source: string) => await until(source, (answer) => answer);

async function call(
  source: string,
  args: unknown[]
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}/api/call/${source}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });

  return { status: response.status, body: await response.json() };
}

const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? value.filter(isRow) : [];

const todoTitles = (answer: unknown) => rows(answer).map((todo) => todo.title);

/** The account once it has this status, without the computer and the memory that ride on the same stream. */
const withStatus = (status: string) => (answer: unknown) => {
  if (!isRow(answer) || answer.status !== status) {
    return;
  }

  const { computer: _computer, memory: _memory, ...account } = answer;

  return account;
};

/** What the imp remembers, once `accept` takes its entries; it rides on the account stream. */
const remembered =
  (accept: (entries: Row[]) => boolean) => (answer: unknown) => {
    if (!isRow(answer) || !isRow(answer.memory)) {
      return;
    }

    const entries = rows(answer.memory.entries);

    return accept(entries) ? entries : undefined;
  };

/** A chat answer once the agent is between turns and `accept` takes its messages. */
const settledChat =
  (accept: (messages: Row[]) => boolean) => (answer: unknown) => {
    if (!isRow(answer) || answer.busy !== false) {
      return;
    }

    const messages = rows(answer.messages);

    return accept(messages) ? messages : undefined;
  };

before(async () => {
  const listening = Promise.withResolvers<undefined>();

  // Keep reading after the host listens: the machine runtime shares this pipe and stops when nobody reads it.
  host.stdout.on("data", (chunk: Buffer) => {
    if (chunk.toString("utf-8").includes("host on http://")) {
      listening.resolve(undefined);
    }
  });
  host.once("exit", () => {
    listening.reject(new Error("the test host exited before it listened"));
  });
  await listening.promise;
});

after(() => {
  host.kill();
});

test("a source or mutation nobody owns is not found, and a call must be JSON", async () => {
  assert.equal((await fetch(`${base}/api/live/nothing`)).status, 404);
  assert.equal((await fetch(`${base}/api/other`)).status, 404);
  assert.deepEqual(await call("nothing", []), {
    status: 404,
    body: { error: "no mutation nothing" },
  });

  const form = await fetch(`${base}/api/call/chatStop`, {
    method: "POST",
    body: "a=1",
  });

  assert.equal(form.status, 415);
});

test("the host tells a web client the address it was reached at", async () => {
  const direct = await fetch(`${base}/assets/host.json`);
  assert.deepEqual(await direct.json(), { origin: base });

  const proxied = await fetch(`${base}/assets/host.json`, {
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "imp.tail.ts.net",
    },
  });

  assert.deepEqual(await proxied.json(), { origin: "https://imp.tail.ts.net" });
});

test("the shell lists the installed apps and the running version", async () => {
  assert.deepEqual(await first("apps"), [
    {
      id: "todos",
      name: "Todos",
      description: "A list of things to do. The agent can read and change it.",
      symbol: "symbol:checkmark",
      cover: "assets/art/todos.jpg",
      draft: false,
      undo: "",
    },
  ]);
  assert.deepEqual(await first("version"), { version: "dev" });
});

test("the computer's state rides on the account stream", async () => {
  const account = await first("account");

  assert.ok(isRow(account) && isRow(account.computer));
  assert.equal(account.computer.kind, "dev");
  assert.equal(account.computer.name, "This computer (development)");
});

test("a message is refused until ChatGPT is signed in", async () => {
  await until("account", withStatus("signedOut"));
  assert.deepEqual(await call("chatSend", ["Hello", ""]), {
    status: 200,
    body: { ok: false, error: "Sign in with ChatGPT first." },
  });
});

test("signing in shows the device code, then the account", async () => {
  const waiting = until("account", withStatus("waiting"));
  assert.deepEqual(await call("accountSignIn", []), {
    status: 200,
    body: { ok: true, error: "" },
  });
  assert.deepEqual(await waiting, {
    status: "waiting",
    code: "TEST-1234",
    url: "https://auth.openai.com/codex/device",
    error: "",
    email: "",
    plan: "",
  });
  assert.deepEqual(await until("account", withStatus("signedIn")), {
    status: "signedIn",
    code: "",
    url: "",
    error: "",
    email: "tester@example.com",
    plan: "plus",
  });
});

test("a todo added from the app's view is listed, and one without a title is refused", async () => {
  assert.deepEqual(await first("todosList"), []);
  assert.deepEqual(await call("todosAdd", ["Pack camera"]), {
    status: 200,
    body: { ok: true, error: "" },
  });
  assert.deepEqual(await call("todosAdd", ["  "]), {
    status: 200,
    body: { ok: false, error: "A todo needs a title." },
  });
  assert.deepEqual(await first("todosList"), [
    { id: "1", title: "Pack camera", done: false },
  ]);
});

test("an open list hears of a change without asking again", async () => {
  const done = until("todosList", (answer) =>
    rows(answer).some((todo) => todo.done === true) ? answer : undefined
  );

  assert.deepEqual(await call("todosSetDone", ["1", true]), {
    status: 200,
    body: { ok: true, error: "" },
  });
  assert.deepEqual(await done, [{ id: "1", title: "Pack camera", done: true }]);
  assert.deepEqual(await call("todosSetDone", ["99", true]), {
    status: 200,
    body: { ok: false, error: "No todo with id 99." },
  });
  assert.deepEqual(await call("todosNothing", []), {
    status: 200,
    body: { ok: false, error: "The todos app has no operation named nothing." },
  });
});

test("the assistant adds a todo with the app's tool, and the transcript says what it did", async () => {
  assert.deepEqual(await call("chatSend", ["  "]), {
    status: 200,
    body: { ok: false, error: "Write a message first." },
  });
  assert.deepEqual(
    await call("chatSend", ["Please add todo: Book train to Kraków", ""]),
    {
      status: 200,
      body: { ok: true, error: "" },
    }
  );
  await until("todosList", (answer) =>
    todoTitles(answer).includes("Book train to Kraków") ? answer : undefined
  );

  const messages = await until(
    "chat",
    settledChat((all) => all.at(-1)?.text === "Done.")
  );

  assert.deepEqual(
    messages.map(({ role, text, title, detail, icon, failed }) => ({
      role,
      text,
      title,
      detail,
      icon,
      failed,
    })),
    [
      {
        role: "user",
        text: "Please add todo: Book train to Kraków",
        title: "",
        detail: "",
        icon: "",
        failed: false,
      },
      {
        role: "activity",
        text: '{"ok":true,"error":""}',
        title: "Todos · Add",
        detail: "Book train to Kraków",
        icon: "symbol:checkmark",
        failed: false,
      },
      {
        role: "assistant",
        text: "Done.",
        title: "",
        detail: "",
        icon: "",
        failed: false,
      },
    ]
  );
});

test("a message sent beside an open app reaches the agent with the app's name, and the transcript without it", async () => {
  assert.deepEqual(
    await call("chatSend", ["Add todo: Call the vet", "todos"]),
    { status: 200, body: { ok: true, error: "" } }
  );

  const messages = await until(
    "chat",
    settledChat((all) => all.length === 6 && all.at(-1)?.text === "Done.")
  );

  assert.equal(messages[3]?.text, "Add todo: Call the vet");
  assert.deepEqual(todoTitles(await first("todosList")), [
    "Pack camera",
    "Book train to Kraków",
    "Call the vet",
  ]);
});

test("the imp remembers what it is told, Settings shows it, and the person can make it forget", async () => {
  assert.deepEqual(
    await until(
      "account",
      remembered(() => true)
    ),
    []
  );
  assert.deepEqual(
    await call("chatSend", ["Please remember: Prefers trains to planes", ""]),
    { status: 200, body: { ok: true, error: "" } }
  );
  assert.deepEqual(
    await until(
      "account",
      remembered((entries) => entries.length > 0)
    ),
    [
      {
        id: "user",
        title: "You",
        kind: "",
        facts: ["Prefers trains to planes"],
        links: [],
      },
    ]
  );
  await until(
    "chat",
    settledChat(
      (all) => all.at(-2)?.text === "Remembered 1 new fact about user."
    )
  );

  const forgotten = until(
    "account",
    remembered((entries) => entries.length === 0)
  );

  assert.deepEqual(await call("memoryForget", ["user", ""]), {
    status: 200,
    body: { ok: true, error: "" },
  });
  assert.deepEqual(await forgotten, []);
});

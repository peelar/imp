// One app's server code, in a worker of its own. The module's default export is the app (see sdk/app.ts); its
// database lives on the host, so every `app.db` call goes to the host and back.
import { parentPort, workerData } from "node:worker_threads";

const { appId, code } = workerData;
let nextId = 1;
const waiting = new Map();

async function db(op, payload) {
  const id = nextId++;

  return await new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    parentPort.postMessage({ t: "db", id, op, ...payload });
  });
}

const app = Object.freeze({
  id: appId,
  db: Object.freeze({
    all: async (sql, ...params) => await db("all", { sql, params }),
    get: async (sql, ...params) => await db("get", { sql, params }),
    run: async (sql, ...params) => await db("run", { sql, params }),
    /** Runs the statements in one transaction: all of them or none. */
    batch: async (statements) => await db("batch", { statements }),
  }),
});

const errorText = (error) =>
  error instanceof Error ? error.message : String(error);

try {
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );

  const definition = module.default ?? {};
  const operations = definition.operations ?? {};

  for (const [name, operation] of Object.entries(operations)) {
    if (typeof operation?.run !== "function") {
      throw new TypeError(`the operation ${name} has no run function`);
    }
  }

  // The host checks the rest of the manifest: it holds the rules for names, kinds and params.
  const manifest = {
    schema: definition.schema ?? [],
    operations: Object.entries(operations).map(([name, operation]) => ({
      name,
      kind: operation.kind,
      description: operation.description,
      params: operation.params,
      agent: operation.agent !== false,
    })),
  };

  parentPort.on("message", async (message) => {
    if (message.t === "dbResult") {
      const w = waiting.get(message.id);
      waiting.delete(message.id);

      if (message.ok) {
        w?.resolve(message.value);
      } else {
        w?.reject(new Error(message.error));
      }

      return;
    }

    if (message.t !== "call") {
      return;
    }

    try {
      const operation = Object.hasOwn(operations, message.name)
        ? operations[message.name]
        : undefined;

      if (!operation) {
        throw new Error(`${appId} has no operation named ${message.name}`);
      }

      const value = await operation.run(message.args, app);
      parentPort.postMessage({
        t: "result",
        id: message.id,
        ok: true,
        value: value ?? null,
      });
    } catch (error) {
      parentPort.postMessage({
        t: "result",
        id: message.id,
        ok: false,
        error: errorText(error),
      });
    }
  });
  parentPort.postMessage({ t: "ready", manifest });
} catch (error) {
  parentPort.postMessage({
    t: "failed",
    error:
      error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
}

// The app socket: the one WebSocket the host opens to agentd on the agent's machine, and the versions that run
// through it. Each version runs in a slot. The host says what every slot should run; the machine says what loaded,
// answers calls, and asks for the slot's data, which stays on the host (data.ts), and for its fetches with the owner's
// keys, which the host sends (`fetch` in the options).
//
// The machine's processes may not survive a suspend, so every connection loads every slot again, and whatever was
// waiting on a lost connection fails with a message to try again.
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { type RawData, WebSocket } from "ws";
import type { Json } from "../../../sdk/app.ts";
import type { AppData } from "./data.ts";
import { type AppInfo, appTopic } from "./folders.ts";
import { checkManifest, type Loaded } from "./manifest.ts";
import type { Topics } from "../live/live.ts";
import type { Machine } from "../machine/machine.ts";
import {
  type Args,
  type DbResult,
  type FetchRequest,
  type FromAgentd,
  fromAgentdCheck,
  type SqlRequest,
  type ToAgentd,
} from "./protocol.ts";

const CALL_TIMEOUT_MS = 60_000;

export type AppMachineOptions = {
  /** What runs in each slot to start with. */
  readonly slots: Iterable<readonly [slot: string, app: AppInfo]>;
  readonly machine: () => Promise<Machine>;
  readonly data: AppData;
  readonly topics: Topics;
  readonly log: (message: string) => void;
  /** Sends the `app.fetch` of the version in `slot`, and answers what came back; throws why it may not. */
  readonly fetch: (slot: string, request: FetchRequest) => Promise<Json>;
};

export type AppMachine = ReturnType<typeof appMachine>;

type Message<T extends FromAgentd["t"]> = Extract<FromAgentd, { t: T }>;

const asError = (cause: unknown) =>
  cause instanceof Error ? cause : new Error(String(cause));

const send = (ws: WebSocket, message: ToAgentd) => {
  ws.send(JSON.stringify(message));
};

export function appMachine(options: AppMachineOptions) {
  const { log } = options;
  const slots = new Map<string, AppInfo>(options.slots);
  const loads = slotLoads();
  const calls = openCalls();
  const answers = slotAnswers({ ...options, slots, loads });

  const sendLoad = (ws: WebSocket, slot: string, app: AppInfo) => {
    send(ws, { t: "load", app: slot, hash: app.hash, code: app.code });
  };

  const socket = agentdSocket({
    machine: options.machine,
    log,
    opened(ws) {
      // agentd skips a version it already runs.
      for (const [slot, app] of slots) {
        sendLoad(ws, slot, app);
      }
    },
    received(ws, message) {
      if (message.t === "loaded") {
        answers.loaded(message);
      } else if (message.t === "loadFailed") {
        answers.loadFailed(message);
      } else if (message.t === "result") {
        calls.finish(message);
      } else if (message.request.op === "fetch") {
        // The answer comes when the service's does; the socket may be gone by then.
        answers
          .fetch(message.id, message.app, message.request)
          .then((result) => {
            if (ws.readyState === WebSocket.OPEN) {
              send(ws, result);
            }

            return result;
          })
          .catch((cause: unknown) => {
            log(`app ${message.app}: ${asError(cause).message}`);
          });
      } else {
        send(ws, answers.db(message.id, message.app, message.request));
      }
    },
    lost() {
      const error = new Error(
        "The connection to the agent's machine was lost; try again."
      );

      loads.lose(error);
      calls.lose(error);
    },
  });

  /** The open socket and the version in a slot, once it loaded; throws why it did not. */
  async function ready(slot: string) {
    if (!slots.has(slot)) {
      throw new Error(`Nothing runs in ${slot}.`);
    }

    const ws = await socket.connect();

    return { ws, version: await loads.wait(slot) };
  }

  return {
    /** What every slot runs. */
    slots: (): ReadonlyMap<string, AppInfo> => slots,
    /** The version in a slot, once it loaded; throws why it did not. */
    loaded: async (slot: string) => (await ready(slot)).version,
    /** Whether the socket to the machine is open now, so a call needs no machine started. */
    awake: () => socket.open() !== undefined,
    /**
     * The version in a slot as it last loaded, without reaching the machine: it stays known while the machine is away,
     * until the slot runs something else.
     */
    known: (slot: string) => answers.known(slot),
    /** Starts `app` in `slot`, replacing what ran there, and answers it once it loaded and its data migrated. */
    async install(slot: string, app: AppInfo) {
      const ws = socket.open();

      slots.set(slot, app);
      loads.forget(slot);
      answers.forget(slot);

      if (ws) {
        sendLoad(ws, slot, app);
      }

      return (await ready(slot)).version;
    },
    /** Stops whatever runs in `slot`, and answers what it was. */
    uninstall(slot: string) {
      const app = slots.get(slot);
      const ws = socket.open();

      slots.delete(slot);
      loads.stop(slot);
      answers.forget(slot);

      if (ws) {
        send(ws, { t: "unload", app: slot });
      }

      return app;
    },
    /** Runs an operation of the version in `slot`. The caller has checked the arguments against its params. */
    async call(slot: string, name: string, args: Args) {
      const { ws } = await ready(slot);

      const { id, answer } = calls.start(
        () =>
          `The ${slots.get(slot)?.id ?? slot} app did not answer ${name} within ${CALL_TIMEOUT_MS / 1000} s.`
      );

      send(ws, { t: "call", id, app: slot, name, args });

      return await answer;
    },
    /** Drops the socket, so the next call connects again, to wherever the machine is by then. */
    disconnect() {
      socket.close();
    },
  };
}

type SlotState = Pick<
  AppMachineOptions,
  "data" | "topics" | "log" | "fetch"
> & {
  readonly slots: ReadonlyMap<string, AppInfo>;
  readonly loads: ReturnType<typeof slotLoads>;
};

/** What the host does with each thing the machine says about a slot. */
function slotAnswers({ slots, loads, data, topics, log, fetch }: SlotState) {
  /** Each slot's version as it last loaded, kept across connections. */
  const known = new Map<string, Loaded>();

  /** The slot's version, when the message is about the one the slot runs now. */
  const current = (message: Message<"loaded" | "loadFailed">) => {
    const app = slots.get(message.app);

    return app?.hash === message.hash ? app : undefined;
  };

  return {
    /** A version loaded: it runs once its manifest follows the rules and its data has its migrations. */
    loaded(message: Message<"loaded">) {
      const app = current(message);

      if (!app) {
        return;
      }

      try {
        const version = checkManifest(app.id, message.manifest);

        data.migrate(message.app, app.id, version.manifest.schema);
        loads.settle(message.app, version);
        known.set(message.app, version);
      } catch (error) {
        loads.settle(message.app, asError(error));

        return;
      }

      // A new version may answer differently: refresh the app's open views.
      topics.changed(appTopic(app.id));
    },
    loadFailed(message: Message<"loadFailed">) {
      const app = current(message);

      if (!app) {
        return;
      }

      const [reason = ""] = message.error.split("\n");

      log(`app ${message.app} failed to load: ${message.error}`);
      loads.settle(
        message.app,
        new Error(`The ${app.id} app's server.ts failed to start: ${reason}`)
      );
    },
    known: (slot: string) => known.get(slot),
    forget: (slot: string) => {
      known.delete(slot);
    },
    /** A worker's fetch, sent from the host with the owner's keys once they allowed the app to use them. */
    async fetch(
      id: number,
      slot: string,
      request: FetchRequest
    ): Promise<DbResult> {
      try {
        if (!slots.has(slot)) {
          throw new Error(`no app ${slot}`);
        }

        return {
          t: "dbResult",
          id,
          ok: true,
          value: await fetch(slot, request),
        };
      } catch (error) {
        return { t: "dbResult", id, ok: false, error: asError(error).message };
      }
    },
    /** A worker's database request, answered from the slot's data on the host. */
    db(id: number, slot: string, request: SqlRequest): DbResult {
      try {
        const app = slots.get(slot);

        if (!app) {
          throw new Error(`no app ${slot}`);
        }

        const { value, wrote } = data.request(slot, request);

        if (wrote) {
          topics.changed(appTopic(app.id));
        }

        return { t: "dbResult", id, ok: true, value };
      } catch (error) {
        return { t: "dbResult", id, ok: false, error: asError(error).message };
      }
    },
  };
}

/** Per slot: the version that loaded on this connection or why it did not, and who waits to hear. */
function slotLoads() {
  const loaded = new Map<string, Loaded>();
  const failures = new Map<string, Error>();
  const waiting = new Map<string, PromiseWithResolvers<Loaded>>();

  return {
    /** The slot is about to run something else: what it loaded says nothing about that. */
    forget(slot: string) {
      loaded.delete(slot);
      failures.delete(slot);
    },
    /** The slot runs nothing from now on: whoever waited for its version hears so. */
    stop(slot: string) {
      loaded.delete(slot);
      failures.delete(slot);
      waiting.get(slot)?.reject(new Error(`${slot} was stopped.`));
      waiting.delete(slot);
    },
    settle(slot: string, result: Loaded | Error) {
      const waiter = waiting.get(slot);

      waiting.delete(slot);

      if (result instanceof Error) {
        failures.set(slot, result);
        waiter?.reject(result);
      } else {
        failures.delete(slot);
        loaded.set(slot, result);
        waiter?.resolve(result);
      }
    },
    /** The slot's version, once it loaded; throws why it did not. */
    async wait(slot: string) {
      const failure = failures.get(slot);

      if (failure) {
        throw failure;
      }

      const version = loaded.get(slot);

      if (version) {
        return version;
      }

      const waiter = waiting.get(slot) ?? Promise.withResolvers<Loaded>();

      waiting.set(slot, waiter);

      return await waiter.promise;
    },
    /** The connection is gone, and every load with it. */
    lose(error: Error) {
      for (const waiter of waiting.values()) {
        waiter.reject(error);
      }

      loaded.clear();
      failures.clear();
      waiting.clear();
    },
  };
}

/** The calls the machine has not answered yet. */
function openCalls() {
  const calls = new Map<
    string,
    PromiseWithResolvers<Json> & { readonly timer: NodeJS.Timeout }
  >();

  return {
    /** A new call's id and its answer, which fails with `late()` when the machine takes too long. */
    start(late: () => string) {
      const id = randomUUID();
      const answer = Promise.withResolvers<Json>();

      const timer = setTimeout(() => {
        calls.delete(id);
        answer.reject(new Error(late()));
      }, CALL_TIMEOUT_MS);

      calls.set(id, { ...answer, timer });

      return { id, answer: answer.promise };
    },
    finish(message: Message<"result">) {
      const call = calls.get(message.id);

      if (!call) {
        return;
      }

      calls.delete(message.id);
      clearTimeout(call.timer);

      if (message.ok) {
        call.resolve(message.value);
      } else {
        call.reject(new Error(message.error || "The app failed."));
      }
    },
    /** The connection is gone, and every answer with it. */
    lose(error: Error) {
      for (const call of calls.values()) {
        clearTimeout(call.timer);
        call.reject(error);
      }

      calls.clear();
    },
  };
}

type SocketOptions = {
  readonly machine: () => Promise<Machine>;
  readonly log: (message: string) => void;
  /** A new connection: the machine may run nothing the host asked for before. */
  readonly opened: (ws: WebSocket) => void;
  readonly received: (ws: WebSocket, message: FromAgentd) => void;
  readonly lost: () => void;
};

/** The connection to agentd: opened when first needed, and again after it is lost. */
function agentdSocket(options: SocketOptions) {
  const { log } = options;
  let socket: WebSocket | undefined;
  let connecting: Promise<WebSocket> | undefined;

  const open = () =>
    socket?.readyState === WebSocket.OPEN ? socket : undefined;

  async function dial() {
    const endpoint = await (await options.machine()).appSocket();

    const ws = new WebSocket(endpoint.url, {
      headers: { ...endpoint.headers },
      maxPayload: 64 * 1024 * 1024,
    });

    // Rejects when the socket fails before it opens.
    await once(ws, "open");
    ws.on("message", (frame) => {
      // The machine runs code the agent wrote, so nothing it sends is used before it passes the protocol's check.
      const message = parse(frame);

      if (message) {
        options.received(ws, message);
      } else {
        log("app socket: dropped a message that is not in the protocol");
      }
    });
    ws.on("close", () => {
      if (socket === ws) {
        socket = undefined;
        options.lost();
      }
    });
    ws.on("error", (error) => {
      log(`app socket: ${error.message}`);
    });
    socket = ws;
    options.opened(ws);

    return ws;
  }

  return {
    /** The socket, if it is open now. */
    open,
    async connect() {
      const ws = open();

      if (ws) {
        return ws;
      }

      connecting ??= dial().finally(() => {
        connecting = undefined;
      });

      return await connecting;
    },
    close() {
      socket?.close();
    },
  };
}

const bytes = (frame: RawData) => {
  if (Buffer.isBuffer(frame)) {
    return frame;
  }

  return Array.isArray(frame) ? Buffer.concat(frame) : Buffer.from(frame);
};

function parse(frame: RawData): FromAgentd | undefined {
  try {
    const message: unknown = JSON.parse(bytes(frame).toString("utf-8"));

    return fromAgentdCheck.check(message) ? message : undefined;
  } catch {
    return undefined;
  }
}

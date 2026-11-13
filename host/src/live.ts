// Live answers. Every resource the shell shows is a server-sent event stream: the host sends the answer when the
// stream opens, and again whenever one of its topics changes and the new answer differs. Writes name the topics they
// change (`changed("app:todos")`), so the agent's changes and the user's reach every open view the same way.
import type { IncomingMessage, ServerResponse } from "node:http";

export class Topics {
  readonly #listeners = new Map<string, Set<() => void>>();

  on(topic: string, listener: () => void): () => void {
    let set = this.#listeners.get(topic);

    if (!set) {
      this.#listeners.set(topic, (set = new Set()));
    }

    set.add(listener);

    return () => {
      set.delete(listener);

      if (set.size === 0) {
        this.#listeners.delete(topic);
      }
    };
  }

  changed(topic: string): void {
    for (const listener of [...(this.#listeners.get(topic) ?? [])]) {
      listener();
    }
  }
}

export type LiveSource = {
  /** The topics whose changes can change this answer. */
  readonly topics: readonly string[];
  load(): Promise<unknown>;
};

const HEARTBEAT_MS = 20_000;

/** Changes that arrive together, such as a streamed reply's tokens, are sent as one answer at most this often. */
const COALESCE_MS = 40;

/** Serves one resource as an event stream until the client goes away. */
export async function serveLive(
  req: IncomingMessage,
  res: ServerResponse,
  topics: Topics,
  source: LiveSource
) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let closed = false;
  let last = "";
  let loading = false;
  let again = false;
  let timer: NodeJS.Timeout | undefined;

  const push = async () => {
    if (loading) {
      again = true;

      return;
    }

    loading = true;

    try {
      do {
        again = false;
        const value = JSON.stringify(await source.load());

        if (!closed && value !== last) {
          last = value;
          res.write(`data: ${value}\n\n`);
        }
      } while (again && !closed);
    } catch (error) {
      if (!closed) {
        res.write(
          `event: failure\ndata: ${JSON.stringify(String(error instanceof Error ? error.message : error))}\n\n`
        );
      }
    } finally {
      loading = false;
    }
  };

  const schedule = () => {
    timer ??= setTimeout(() => {
      timer = undefined;
      void push();
    }, COALESCE_MS);
  };

  const off = source.topics.map((topic) => topics.on(topic, schedule));

  const heartbeat = setInterval(
    () => res.write(": heartbeat\n\n"),
    HEARTBEAT_MS
  );

  req.on("close", () => {
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(timer);

    for (const stop of off) {
      stop();
    }
  });
  await push();
}

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
    // A copy: a listener may stop listening while it is told.
    const listeners = [...(this.#listeners.get(topic) ?? [])];

    for (const listener of listeners) {
      listener();
    }
  }
}

/** What a source answers: anything JSON writes as it is. */
export type Answer =
  | null
  | boolean
  | number
  | string
  | readonly Answer[]
  | { readonly [key: string]: Answer };

export type LiveSource = {
  /** The topics whose changes can change this answer. */
  readonly topics: readonly string[];
  readonly load: () => Promise<Answer>;
};

export type LiveStream = {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly topics: Topics;
  readonly source: LiveSource;
};

const HEARTBEAT_MS = 20_000;

/** Changes that arrive together, such as a streamed reply's tokens, are sent as one answer at most this often. */
const COALESCE_MS = 40;

/** Serves one resource as an event stream until the client goes away. */
export async function serveLive({ req, res, topics, source }: LiveStream) {
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

  /** Sends the answer when it differs from the last one sent. */
  const send = async () => {
    const value = JSON.stringify(await source.load());

    if (!closed && value !== last) {
      last = value;
      res.write(`data: ${value}\n\n`);
    }
  };

  /** One load at a time: a change that arrives during a load asks for another when it ends. */
  const push = async () => {
    if (loading) {
      again = true;

      return;
    }

    loading = true;
    again = false;

    try {
      await send();
    } catch (error) {
      again = false;

      if (!closed) {
        res.write(
          `event: failure\ndata: ${JSON.stringify(error instanceof Error ? error.message : String(error))}\n\n`
        );
      }
    } finally {
      loading = false;
    }

    if (again && !closed) {
      await push();
    }
  };

  const schedule = () => {
    timer ??= setTimeout(() => {
      timer = undefined;
      push().catch((cause: unknown) => {
        console.error("live:", cause);
      });
    }, COALESCE_MS);
  };

  const off = source.topics.map((topic) => topics.on(topic, schedule));

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, HEARTBEAT_MS);

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

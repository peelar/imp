// The fetch the MCP client and its OAuth sign-in use: every request goes out through `send`, which the host's egress
// proxy serves, naming the server's connection, so the addon puts that server's keys on it and takes them out of the
// answer. The client only ever holds a key's stand-in. The answer comes back whole, so the client opens no stream
// that stays open: a GET for the server's own event stream is answered 405, which tells it the server offers none,
// and it asks again instead.

/** One of the host's requests for a connection, and its answer (the vault's `sendFor`). */
export type ConnectionSend = (request: {
  readonly onlyFor: string;
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}) => Promise<{
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}>;

/** Statuses whose answer has no body. */
const EMPTY = new Set([101, 204, 205, 304]);

const bodyText = async (body: RequestInit["body"]) => {
  if (body === undefined || body === null) {
    return "";
  }

  return await new Response(body).text();
};

/** The fetch for the connection `onlyFor` names. */
export function connectionFetch(send: ConnectionSend, onlyFor: string) {
  return async (input: string | URL, init: RequestInit = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers));
    const method = (init.method ?? "GET").toUpperCase();

    if (method === "GET" && headers.accept?.includes("text/event-stream")) {
      return new Response(null, { status: 405 });
    }

    const answer = await send({
      onlyFor,
      url: String(input),
      method,
      headers: { "user-agent": "Imp", ...headers },
      body: await bodyText(init.body),
    });

    return new Response(EMPTY.has(answer.status) ? null : answer.body, {
      status: answer.status,
      headers: Object.entries(answer.headers).filter(
        ([name]) =>
          !["content-length", "transfer-encoding", "connection"].includes(name)
      ),
    });
  };
}

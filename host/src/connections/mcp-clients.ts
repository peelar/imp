// The MCP client's connections to the servers the owner signed in to: one client per server, opened at its first use
// and dropped on a failure, so the next use connects again, and each server's tools, kept for a few minutes. Every
// request goes through the egress proxy (mcp-fetch.ts), and an OAuth server's tokens are refreshed through it too
// (mcp-sign-in.ts).
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { Json } from "../../../sdk/app.ts";
import { why } from "../live/live.ts";
import { type ConnectionSend, connectionFetch } from "./mcp-fetch.ts";
import type { KeptServer, KeptServers } from "./mcp-kept.ts";
import { answerText, type ListedTool, toolsOf } from "./mcp-results.ts";
import {
  accessKey,
  onlyFor,
  type ServerKeys,
  type SignInProvider,
  signInProvider,
} from "./mcp-sign-in.ts";

/** How long a server's list of tools is kept before the next search asks again. */
const TOOLS_MS = 5 * 60_000;

/** What the MCP servers' parts share: the kept list, the vault, the proxy, and why each server last failed. */
export type Shared = {
  readonly kept: KeptServers;
  readonly keys: ServerKeys;
  readonly send: ConnectionSend;
  readonly errors: Map<string, string>;
  readonly changed: () => void;
  readonly log: (line: string) => void;
};

export const newClient = () => new Client({ name: "Imp", version: "1" });

/** A transport to `server`, with its requests through the proxy; signed in with `provider` for OAuth. */
export function transportTo(
  shared: Shared,
  server: KeptServer,
  provider?: SignInProvider
) {
  const url = new URL(server.url);
  const fetch = connectionFetch(shared.send, onlyFor(server.id));

  return provider
    ? new StreamableHTTPClientTransport(url, { fetch, authProvider: provider })
    : new StreamableHTTPClientTransport(url, { fetch });
}

/** Whether the imp may use the server: it needs no sign-in, or the vault has its token or key. */
export const signedIn = (keys: ServerKeys, server: KeptServer) =>
  server.auth === "none" ||
  (server.auth !== "" && keys.has(accessKey(server.id)));

/** A server's tools, and when they were listed. */
type Listed = { readonly at: number; readonly tools: readonly ListedTool[] };

const closeClient = async (client: Promise<Client>) => {
  await (await client).close();
};

export function serverClients(shared: Shared) {
  const { kept, keys, errors, changed, log } = shared;
  const clients = new Map<string, Promise<Client>>();
  const listed = new Map<string, Listed>();

  const forget = (id: string) => {
    const client = clients.get(id);

    clients.delete(id);
    listed.delete(id);

    if (client) {
      closeClient(client).catch((cause: unknown) => {
        log(`connections: ${id}: ${why(cause)}`);
      });
    }
  };

  const open = async (server: KeptServer) => {
    const client = newClient();

    await client.connect(
      transportTo(
        shared,
        server,
        server.auth === "oauth"
          ? signInProvider({ server, keys, servers: kept, redirectUri: "" })
          : undefined
      )
    );

    return client;
  };

  const connect = async (server: KeptServer) => {
    const opened = open(server);

    clients.set(server.id, opened);

    return await opened;
  };

  /** Runs `use` on the server's client; a failure drops the client and shows in Settings. */
  const withClient = async <T>(
    id: string,
    use: (client: Client) => Promise<T>
  ) => {
    const server = kept.get(id);

    if (!server) {
      throw new Error(`There is no server ${id}.`);
    }

    if (!signedIn(keys, server)) {
      throw new Error(
        `${server.name} is not signed in: the user signs in to it in Settings → Connections.`
      );
    }

    try {
      const value = await use(await (clients.get(id) ?? connect(server)));

      if (errors.delete(id)) {
        changed();
      }

      return value;
    } catch (cause) {
      forget(id);
      errors.set(id, why(cause));
      changed();

      throw new Error(`${server.name}: ${why(cause)}`, { cause });
    }
  };

  const tools = async (id: string) => {
    const known = listed.get(id);

    if (known && Date.now() - known.at < TOOLS_MS) {
      return known.tools;
    }

    const found = await withClient(id, async (client) =>
      toolsOf((await client.listTools()).tools)
    );

    const first = !listed.has(id);

    listed.set(id, { at: Date.now(), tools: found });

    // Settings shows how many tools a server has.
    if (first) {
      changed();
    }

    return found;
  };

  return {
    tools,
    call: async (
      id: string,
      tool: string,
      args: { readonly [name: string]: Json }
    ) =>
      await withClient(id, async (client) =>
        answerText(await client.callTool({ name: tool, arguments: args }))
      ),
    /** How many tools the server has, once listed; -1 before. */
    count: (id: string) => listed.get(id)?.tools.length ?? -1,
    forget,
    close: () => {
      for (const id of clients.keys()) {
        forget(id);
      }
    },
  };
}

export type ServerClients = ReturnType<typeof serverClients>;

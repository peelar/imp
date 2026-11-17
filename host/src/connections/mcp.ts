// The MCP servers the owner connects in Settings → Connections, such as Linear, Notion or Sentry, and the host's MCP
// client for them. Remote servers only, over Streamable HTTP: the client runs on the host, and every request it sends
// goes through the egress proxy (mcp-fetch.ts), so the server's tokens stay in the vault and the client holds only
// their stand-ins (mcp-sign-in.ts). The imp reaches the servers' tools through the catalogue (actions/), never as
// tools of its own.
//
// A server signs in one of three ways: OAuth, which Sign in starts and /api/connections/callback finishes
// (mcp-flows.ts); a key the owner pastes, which the proxy puts on its requests as a bearer token; or none, for a
// server that asks for neither. This file keeps the list; mcp-clients.ts talks to the servers.
import { type Reply, refused, why } from "../live/live.ts";
import { type Shared, serverClients, signedIn } from "./mcp-clients.ts";
import type { ConnectionSend } from "./mcp-fetch.ts";
import { serverSignIns } from "./mcp-flows.ts";
import { keptServers } from "./mcp-kept.ts";
import {
  accessKey,
  onlyFor,
  refreshKey,
  type ServerKeys,
} from "./mcp-sign-in.ts";

export type { ServerKeys } from "./mcp-sign-in.ts";

export type { ConnectionSend } from "./mcp-fetch.ts";

const ID = /^[a-z][a-z0-9-]{0,29}$/;

/** An MCP server as Settings shows it. */
export type McpServerView = {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  /** "off" (needs a sign-in), "starting", "waiting" (for the person at `signInUrl`) or "on". */
  readonly status: string;
  readonly signInUrl: string;
  /** How many tools it offers, once listed; -1 before. */
  readonly tools: number;
  readonly error: string;
};

export type McpOptions = {
  readonly file: string;
  readonly keys: ServerKeys;
  readonly send: ConnectionSend;
  readonly changed: () => void;
  readonly log: (line: string) => void;
};

/** What the owner fills in to add a server. */
type NewServer = {
  readonly name: string;
  readonly url: string;
  readonly key: string;
};

const idOf = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 30);

/** The server's address, checked: HTTPS only, since the host sends its requests over TLS. */
function serverUrl(written: string) {
  const trimmed = written.trim();
  const url = URL.canParse(trimmed) ? new URL(trimmed) : undefined;

  return url?.protocol === "https:" &&
    url.username === "" &&
    url.password === ""
    ? url
    : undefined;
}

/** Adds a server; with a key, the proxy puts it on the server's requests as a bearer token. */
async function addServer(
  { kept, keys, changed }: Shared,
  input: NewServer
): Promise<Reply> {
  const name = input.name.trim();
  const id = idOf(name);
  const url = serverUrl(input.url);
  const key = input.key.trim();

  if (!ID.test(id)) {
    return refused("Name it with a letter first, such as Linear.");
  }

  if (!url) {
    return refused(
      "Give the server's HTTPS address, such as https://mcp.linear.app/mcp."
    );
  }

  if (kept.get(id)) {
    return refused(`There is a server named ${name} already.`);
  }

  try {
    await keys.ready();
  } catch (cause) {
    return refused(why(cause));
  }

  if (key !== "") {
    const stored = await keys.putFor({
      name: accessKey(id),
      value: key,
      onlyFor: onlyFor(id),
      rules: [
        { host: url.hostname, header: "Authorization", prefix: "Bearer " },
      ],
    });

    if (!stored.ok) {
      return stored;
    }
  }

  kept.put({
    id,
    name,
    url: url.href,
    auth: key === "" ? "" : "key",
    clientId: "",
    redirectUri: "",
    tokenHost: "",
  });
  changed();

  return { ok: true, error: "" };
}

/** Takes the server's keys out of the vault: its access token or key, then its refresh token. */
async function removeKeys(keys: ServerKeys, id: string): Promise<Reply> {
  const remove = async (name: string) =>
    keys.has(name) ? await keys.remove(name) : { ok: true, error: "" };

  const access = await remove(accessKey(id));

  return access.ok ? await remove(refreshKey(id)) : access;
}

export function mcpServers(options: McpOptions) {
  const shared: Shared = {
    kept: keptServers(options.file, options.log),
    keys: options.keys,
    send: options.send,
    errors: new Map(),
    changed: options.changed,
    log: options.log,
  };

  const { kept, keys, errors, changed } = shared;
  const clients = serverClients(shared);
  const signIns = serverSignIns(shared, clients);

  return {
    /** The servers the imp may use: the ones signed in. */
    list: () =>
      kept
        .all()
        .filter((server) => signedIn(keys, server))
        .map(({ id, name }) => ({ id, name })),
    tools: clients.tools,
    call: clients.call,
    /** What Settings shows. */
    state: (): McpServerView[] =>
      kept.all().map((server) => ({
        id: server.id,
        name: server.name,
        url: server.url,
        status:
          signIns.status(server.id) || (signedIn(keys, server) ? "on" : "off"),
        signInUrl: signIns.pageUrl(server.id),
        tools: clients.count(server.id),
        error: errors.get(server.id) ?? "",
      })),
    add: async (input: NewServer) => await addServer(shared, input),
    signIn: signIns.signIn,
    cancel: signIns.cancel,
    finish: signIns.finish,
    /** Removes the server and its keys from the vault. The account at the service is untouched. */
    remove: async (id: string): Promise<Reply> => {
      if (!kept.get(id)) {
        return refused(`There is no server ${id}.`);
      }

      const removed = await removeKeys(keys, id);

      if (!removed.ok) {
        return removed;
      }

      signIns.drop(id);
      errors.delete(id);
      clients.forget(id);
      kept.remove(id);
      changed();

      return { ok: true, error: "" };
    },
    close: clients.close,
  };
}

// An MCP server's sign-in while it is under way. Sign in in Settings connects to the server: one that needs no
// sign-in answers at once, and one with OAuth sends the host to its sign-in page (mcp-sign-in.ts), which Settings
// opens for the person. Their browser comes back to /api/connections/callback, which finishes it with the code: the
// tokens go to the vault, and the server's tools are listed.
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { type Reply, refused, why } from "../live/live.ts";
import {
  newClient,
  type ServerClients,
  type Shared,
  transportTo,
} from "./mcp-clients.ts";
import type { KeptServer } from "./mcp-kept.ts";
import { type SignInProvider, signInProvider } from "./mcp-sign-in.ts";

type Flow = {
  readonly provider: SignInProvider;
  readonly transport: StreamableHTTPClientTransport;
};

/** What the page the sign-in comes back to tells the person. */
export type Finished = { readonly ok: boolean; readonly message: string };

const lost: Finished = {
  ok: false,
  message:
    "This sign-in is not one Imp is waiting for. Sign in again from Settings → Connections.",
};

/** What finishing a sign-in uses of the sign-ins. */
type Waiting = {
  readonly flows: ReadonlyMap<string, Flow>;
  readonly kept: Shared["kept"];
  readonly fail: (id: string, error: string) => void;
  readonly settled: (id: string, auth: string) => Promise<void>;
};

/** Finishes the sign-in whose `state` the page sent back, with its code. */
async function finishSignIn(
  { flows, kept, fail, settled }: Waiting,
  params: URLSearchParams
): Promise<Finished> {
  const state = params.get("state");

  const [id = "", flow] =
    [...flows].find(([, open]) => open.provider.expected === state) ?? [];

  const server = kept.get(id);

  if (!flow || !server || flow.provider.until < Date.now()) {
    return lost;
  }

  const denied = params.get("error");

  if (denied) {
    fail(
      id,
      `${server.name} said: ${params.get("error_description") ?? denied}`
    );

    return { ok: false, message: `Imp is not signed in to ${server.name}.` };
  }

  try {
    await flow.transport.finishAuth(params);
  } catch (cause) {
    fail(id, why(cause));

    return {
      ok: false,
      message: `Imp could not sign in to ${server.name}: ${why(cause)}`,
    };
  }

  await settled(id, "oauth");

  return {
    ok: true,
    message: `Imp is signed in to ${server.name}. You can close this tab.`,
  };
}

export function serverSignIns(shared: Shared, clients: ServerClients) {
  const { kept, keys, errors, changed } = shared;
  const flows = new Map<string, Flow>();

  const fail = (id: string, error: string) => {
    flows.delete(id);
    errors.set(id, error);
    changed();
  };

  /** The server signed in as `auth`: what it had connected is dropped, and its tools are listed. */
  const settled = async (id: string, auth: string) => {
    const server = kept.get(id);

    if (server) {
      kept.put({ ...server, auth });
    }

    flows.delete(id);
    clients.forget(id);
    errors.delete(id);
    changed();

    try {
      await clients.tools(id);
    } catch {
      // Settings shows why.
    }
  };

  const start = async (server: KeptServer, origin: string) => {
    const redirectUri = new URL("/api/connections/callback", origin).href;

    const provider = signInProvider({
      server,
      keys,
      servers: kept,
      redirectUri,
    });

    const transport = transportTo(shared, server, provider);
    const client = newClient();

    flows.set(server.id, { provider, transport });
    changed();

    try {
      await client.connect(transport);
      await client.close();
      await settled(server.id, "none");
    } catch (cause) {
      // Sent to the sign-in page: the flow waits for the person.
      if (provider.pageUrl() === "") {
        fail(server.id, why(cause));
      } else {
        changed();
      }
    }
  };

  return {
    /** "starting", "waiting" (for the person at `pageUrl`), or "" when no sign-in is under way. */
    status: (id: string) => {
      const flow = flows.get(id);

      if (!flow) {
        return "";
      }

      return flow.provider.pageUrl() === "" ? "starting" : "waiting";
    },
    pageUrl: (id: string) => flows.get(id)?.provider.pageUrl() ?? "",
    /** Starts the server's sign-in; `origin` is the address the person's browser reaches the host at. */
    signIn: (id: string, origin: string): Reply => {
      const server = kept.get(id);

      if (!server) {
        return refused(`There is no server ${id}.`);
      }

      if (!/^https?:\/\/[^/]+$/.test(origin)) {
        return refused("The sign-in needs the address you reach Imp at.");
      }

      errors.delete(id);
      start(server, origin).catch((cause: unknown) => {
        fail(id, why(cause));
      });

      return { ok: true, error: "" };
    },
    cancel: (id: string) => {
      flows.delete(id);
      changed();
    },
    /** The sign-in page sent the person back: the code becomes tokens in the vault. */
    finish: async (params: URLSearchParams) =>
      await finishSignIn({ flows, kept, fail, settled }, params),
    drop: (id: string) => {
      flows.delete(id);
    },
  };
}

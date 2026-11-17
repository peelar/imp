// An MCP server's OAuth sign-in, for the MCP client's OAuthClientProvider: the host registers itself with the server's
// authorization server, sends the person to its sign-in page, and takes the code it sends back to
// /api/connections/callback. The tokens go straight to the vault, as keys only the host's own requests for this server
// get (`mcp:<id>`); the client is handed their stand-ins, which the egress proxy swaps for them on the way out: the
// access token in the Authorization header on requests to the server, the refresh token in the body of a request to
// the token endpoint. Imp signs in as a public client with PKCE, so there is no client secret to keep.
//
// What a sign-in needs between leaving and coming back (its state, its code verifier, what discovery found) lives in
// memory: a host that restarts in between asks the person to sign in again.
import { randomBytes } from "node:crypto";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import type { Reply } from "../live/live.ts";
import type { KeptServer, KeptServers } from "./mcp-kept.ts";

/** How long a sign-in waits for the person to come back. */
const FLOW_MS = 15 * 60_000;

/** One header a key goes in, on requests to `host`; an empty header puts it only where its stand-in is. */
type KeyRule = {
  readonly host: string;
  readonly header: string;
  readonly prefix: string;
};

/** The vault, as the MCP servers' sign-ins use it: keys only the host's requests for one server get. */
export type ServerKeys = {
  /** Waits for the vault; throws why it is not there. */
  readonly ready: () => Promise<void>;
  readonly has: (name: string) => boolean;
  readonly standIn: (name: string) => string;
  readonly putFor: (key: {
    readonly name: string;
    readonly value: string;
    readonly onlyFor: string;
    readonly rules: readonly KeyRule[];
  }) => Promise<Reply>;
  readonly remove: (name: string) => Promise<Reply>;
};

/** What only the host's requests for the server `id` name, so the addon puts its keys on them. */
export const onlyFor = (id: string) => `mcp:${id}`;

/** The vault's names for a server's keys: its access token (or the key the owner pasted), and its refresh token. */
export const accessKey = (id: string) => `mcp-${id}`;
export const refreshKey = (id: string) => `mcp-${id}-refresh`;

/** A value the egress proxy took out of an answer, which is not the value but a stand-in or asterisks. */
const scrubbed = (keys: ServerKeys, name: string, value: string) =>
  value === keys.standIn(name) || /^\*+$/.test(value);

async function kept(reply: Promise<Reply>) {
  const answer = await reply;

  if (!answer.ok) {
    throw new Error(`The vault did not keep the sign-in: ${answer.error}`);
  }
}

/** The host the token endpoint is on, which the refresh token goes to. */
function tokenHost(state: OAuthDiscoveryState) {
  const endpoint =
    state.authorizationServerMetadata?.token_endpoint ??
    new URL("/token", state.authorizationServerUrl).href;

  return new URL(endpoint).hostname;
}

export type SignInProvider = OAuthClientProvider & {
  /** The person's sign-in page, once the provider was sent there; "" before. */
  readonly pageUrl: () => string;
  /** The `state` the sign-in page sends back. */
  readonly expected: string;
  /** When the sign-in stops waiting for the person. */
  readonly until: number;
};

type ProviderOptions = {
  readonly server: KeptServer;
  readonly keys: ServerKeys;
  readonly servers: KeptServers;
  /** Where the sign-in page sends the person back to; "" for a provider that only refreshes. */
  readonly redirectUri: string;
};

/** Stores a token the server gave, unless it is the one the vault has already, as the proxy wrote it back. */
async function keepToken(
  { keys, server }: ProviderOptions,
  { name, value, host }: { name: string; value: string; host: string }
) {
  if (value === "" || host === "" || scrubbed(keys, name, value)) {
    return;
  }

  await kept(
    keys.putFor({
      name,
      value,
      onlyFor: onlyFor(server.id),
      rules: [{ host, header: "", prefix: "" }],
    })
  );
}

/** The OAuth client the MCP client signs in to `server` as, and refreshes its tokens with. */
export function signInProvider(options: ProviderOptions): SignInProvider {
  const { keys, servers, redirectUri } = options;
  const { id } = options.server;
  const server = () => servers.get(id) ?? options.server;
  const expected = randomBytes(24).toString("base64url");
  let page = "";
  let verifier = "";
  let discovery: OAuthDiscoveryState | undefined;

  return {
    expected,
    until: Date.now() + FLOW_MS,
    pageUrl: () => page,
    get redirectUrl() {
      return redirectUri || server().redirectUri || undefined;
    },
    get clientMetadata() {
      return {
        client_name: "Imp",
        redirect_uris: [redirectUri || server().redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    state: () => expected,
    // A registration is for the address the person comes back to; another one registers again.
    clientInformation: () => {
      const { clientId, redirectUri: registered } = server();

      return clientId && (!redirectUri || registered === redirectUri)
        ? { client_id: clientId }
        : undefined;
    },
    saveClientInformation: (information) => {
      if (information.client_secret) {
        throw new Error(
          `${server().name} registered Imp with a client secret, and Imp signs in only as a public client.`
        );
      }

      servers.put({
        ...server(),
        clientId: information.client_id,
        redirectUri: redirectUri || server().redirectUri,
      });
    },
    tokens: (): StoredOAuthTokens | undefined => {
      if (!keys.has(accessKey(id))) {
        return undefined;
      }

      const access = {
        access_token: keys.standIn(accessKey(id)),
        token_type: "Bearer",
      };

      return keys.has(refreshKey(id))
        ? { ...access, refresh_token: keys.standIn(refreshKey(id)) }
        : access;
    },
    saveTokens: async (tokens) => {
      await keepToken(options, {
        name: accessKey(id),
        value: tokens.access_token,
        host: new URL(server().url).hostname,
      });
      await keepToken(options, {
        name: refreshKey(id),
        value: tokens.refresh_token ?? "",
        host: server().tokenHost,
      });
    },
    redirectToAuthorization: (url) => {
      // Only a sign-in the person started sends them anywhere; a refresh that fails asks them to sign in again.
      if (redirectUri) {
        page = url.href;
      }
    },
    saveCodeVerifier: (codeVerifier) => {
      verifier = codeVerifier;
    },
    codeVerifier: () => verifier,
    saveDiscoveryState: (state) => {
      discovery = state;
      servers.put({ ...server(), tokenHost: tokenHost(state) });
    },
    discoveryState: () => discovery,
    invalidateCredentials: async (scope) => {
      if (scope === "all" || scope === "tokens") {
        await keys.remove(accessKey(id));
        await keys.remove(refreshKey(id));
      }

      if (scope === "all" || scope === "client") {
        servers.put({ ...server(), clientId: "" });
      }

      if (scope === "discovery") {
        discovery = undefined;
      }
    },
  };
}

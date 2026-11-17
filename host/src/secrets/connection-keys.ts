// The keys the host's own connections keep in the vault, such as an MCP server's OAuth tokens, apart from the owner's
// secrets: each is for one connection (`onlyFor`, such as "mcp:linear"), and only the host's own requests that name
// it get it (sendFor), through the same egress proxy the imp's commands use. A rule with an empty header puts the key
// only where the request holds its stand-in, as a token endpoint takes a refresh token in the body. The imp never
// learns of these keys, Settings → Secrets does not list them, and the owner cannot add a key of their names
// (descriptions.ts).
import { type AppAnswer, sendAppRequest, type ViaProxy } from "./app-fetch.ts";
import { type Described, standInFor } from "./descriptions.ts";
import type { HostRule } from "./services.ts";
import type { Vault } from "./vault.ts";

/** A key one of the host's connections keeps. An empty value keeps the one the vault has. */
export type ConnectionKey = {
  readonly name: string;
  readonly value: string;
  readonly onlyFor: string;
  readonly rules: readonly HostRule[];
};

/** One of the host's own requests for a connection. */
export type ConnectionRequest = {
  readonly onlyFor: string;
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

type Reply = { readonly ok: boolean; readonly error: string };

type ConnectionKeysOptions = {
  readonly vault: Vault;
  /** Every secret in the vault, the owner's and the connections'. */
  readonly all: () => readonly Described[];
  /** Applies a change to the vault and reads the secrets back; a failure is the answer. */
  readonly change: (apply: () => Promise<void>) => Promise<Reply>;
  readonly viaProxy: () => Promise<ViaProxy>;
};

export function connectionKeys(options: ConnectionKeysOptions) {
  const { vault, all, change } = options;

  return {
    /** Keeps a connection's key; refused when the owner has a secret of its name. */
    putFor: async (key: ConnectionKey): Promise<Reply> => {
      const taken = all().some(
        (secret) => secret.name === key.name && secret.onlyFor !== key.onlyFor
      );

      if (taken) {
        return {
          ok: false,
          error: `You have a secret named ${key.name} already.`,
        };
      }

      return await change(async () => {
        await vault.put(
          key.name,
          key.value ? { value: key.value } : undefined,
          {
            kind: "key",
            service: "connection",
            // No env: the imp's commands get no stand-in for it, and OpenBao keeps no empty value.
            rules: JSON.stringify(key.rules),
            standIn: standInFor(key.name),
            onlyFor: key.onlyFor,
          }
        );
      });
    },
    /** Whether the vault has a secret named `name`. */
    has: (name: string) => all().some((secret) => secret.name === name),
    /** A key's stand-in, which the egress proxy swaps for its value on the way out. */
    standIn: standInFor,
    /** Sends one of the host's requests for a connection; the addon puts its keys on it and Recent use names it. */
    sendFor: async (request: ConnectionRequest): Promise<AppAnswer> =>
      await sendAppRequest(
        {
          ...request,
          app: request.onlyFor,
          secret: request.onlyFor,
          address: "",
        },
        options.viaProxy
      ),
  };
}

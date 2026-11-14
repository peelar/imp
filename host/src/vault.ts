// The vault for the owner's secrets: an OpenBao server the host runs and owns, in DATA_DIR/vault (vault-server.ts).
// The host starts it, it unseals itself from a key file beside its data (the static seal), and it sets itself up on
// its first start (declarative self-initialization, vault-files.ts): a KV store at secret/, an audit log of every
// request, and two policies.
//
//   imp-admin   what the host signs in with (Settings): it writes, lists and deletes secrets and reads their
//               descriptions, but cannot read a value back. A saved value is never shown again.
//   imp-egress  what the egress proxy gets (egress.ts), and what the host mints for each sign-in it types
//               (secret-logins.ts): a short-lived token that only reads values.
import path from "node:path";
import {
  arr,
  compile,
  map,
  nullable,
  obj,
  opt,
  str,
} from "@earendil-works/pi-schema";
import { answered, readWith, vaultServer } from "./vault-server.ts";

/** A secret as the vault describes it, without its value. */
export type StoredSecret = {
  readonly name: string;
  /** Strings only: OpenBao's custom metadata. */
  readonly meta: Readonly<Record<string, string>>;
  readonly created: string;
  readonly updated: string;
};

export type VaultOptions = {
  readonly dataDir: string;
  /** Where downloaded programs are kept (tools.ts). */
  readonly toolsDir: string;
};

const listing = compile(
  obj({ data: obj({ keys: arr(str()) }, { open: true }) }, { open: true })
);

const description = compile(
  obj(
    {
      data: obj(
        {
          custom_metadata: opt(nullable(map(str()))),
          created_time: opt(str()),
          updated_time: opt(str()),
        },
        { open: true }
      ),
    },
    { open: true }
  )
);

const newToken = compile(
  obj(
    { auth: obj({ client_token: str(), accessor: str() }, { open: true }) },
    { open: true }
  )
);

const fields = compile(
  obj({ data: obj({ data: map(str()) }, { open: true }) }, { open: true })
);

const pathOf = (name: string) => `imp/${name}`;

export function openVault(options: VaultOptions) {
  const server = vaultServer({
    dir: path.join(options.dataDir, "vault"),
    toolsDir: options.toolsDir,
  });

  /** One secret's description; a secret deleted since it was listed has none. */
  const describe = async (name: string): Promise<StoredSecret> => {
    const what = `secret/metadata/${pathOf(name)}`;
    const answer = await server.request("GET", what);

    const { custom_metadata, created_time, updated_time } =
      answer === undefined ? {} : answered(description, answer, what).data;

    return {
      name,
      meta: custom_metadata ?? {},
      created: created_time ?? "",
      updated: updated_time ?? "",
    };
  };

  return {
    /** "stopped", "starting", "ready", or "failed" (with `error`). */
    state: server.state,
    socket: server.socket,
    ready: server.ready,
    list: async (): Promise<StoredSecret[]> => {
      // No secret yet: the path does not exist (404).
      const what = "secret/metadata/imp?list=true";
      const answer = await server.request("GET", what);

      const names =
        answer === undefined ? [] : answered(listing, answer, what).data.keys;

      return await Promise.all(names.map(describe));
    },
    /**
     * Stores new fields (`value`, and for a login `otp`), in place of every field it had, and replaces the
     * description. Undefined fields keep the stored ones.
     */
    put: async (
      name: string,
      stored: Readonly<Record<string, string>> | undefined,
      meta: Readonly<Record<string, string>>
    ) => {
      if (stored) {
        await server.request("POST", `secret/data/${pathOf(name)}`, {
          data: { ...stored },
        });
      }

      await server.request("POST", `secret/metadata/${pathOf(name)}`, {
        custom_metadata: { ...meta },
      });
    },
    /** Removes a secret and every version of its value. */
    remove: async (name: string) => {
      await server.request("DELETE", `secret/metadata/${pathOf(name)}`);
    },
    /** A new token that can only read values, valid for an hour unless renewed. */
    egressToken: async (): Promise<{ token: string; accessor: string }> => {
      const what = "auth/token/create/imp-egress";
      const answer = await server.request("POST", what, {});
      const { auth } = answered(newToken, answer ?? "", what);

      return { token: auth.client_token, accessor: auth.accessor };
    },
    revoke: async (accessor: string) => {
      await server.request("POST", "auth/token/revoke-accessor", { accessor });
    },
    /**
     * A secret's stored fields, read with a read-only token minted for this one read and revoked after it: the host's
     * own token cannot read a value. Only a sign-in reads one (secret-logins.ts).
     */
    read: async (name: string): Promise<Readonly<Record<string, string>>> => {
      const what = `secret/data/${pathOf(name)}`;

      const answer = await server.request(
        "POST",
        "auth/token/create/imp-egress",
        {}
      );

      const { auth } = answered(
        newToken,
        answer ?? "",
        "auth/token/create/imp-egress"
      );

      try {
        await server.ready();
        const read = await readWith(server.socket, auth.client_token, what);

        return answered(fields, read ?? "", what).data.data;
      } finally {
        await server
          .request("POST", "auth/token/revoke-accessor", {
            accessor: auth.accessor,
          })
          .catch((cause: unknown) => {
            // The token lapses within the hour anyway.
            console.error(`vault: revoking a read token: ${String(cause)}`);
          });
      }
    },
    close: server.close,
  };
}

export type Vault = ReturnType<typeof openVault>;

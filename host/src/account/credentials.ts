// pi-ai's CredentialStore on the host's SQLite: model sign-ins survive restarts, and the file is readable by the host
// alone. Writes for one provider run one at a time, so a token refresh and a new sign-in cannot interleave.
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { CreateModelsOptions } from "@earendil-works/pi-ai/models";
import { compile, obj, str } from "@earendil-works/pi-schema";

// pi-ai does not export its auth types by name; these are the same types, read off createModels.
type CredentialStore = NonNullable<CreateModelsOptions["credentials"]>;

type Credential = NonNullable<Awaited<ReturnType<CredentialStore["read"]>>>;

type CredentialInfo = Awaited<ReturnType<CredentialStore["list"]>>[number];

// The rows the two queries below select: both columns are TEXT.
const credentialRow = compile(obj({ credential: str() }));
const providerRow = compile(obj({ provider: str(), credential: str() }));

// SAFETY: only `modify` below writes the credential column, and it writes `JSON.stringify` of the Credential pi-ai
// handed it, so the column's text parses back to a Credential.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse is typed `any`, and Credential is pi-ai's own union, which a schema here could only copy and fall behind.
const parseCredential = (text: string) => JSON.parse(text) as Credential;

export function openCredentialStore(
  path: string
): CredentialStore & { close: () => void } {
  const db = new DatabaseSync(path);

  chmodSync(path, 0o600);
  db.exec(
    "CREATE TABLE IF NOT EXISTS credentials (provider TEXT PRIMARY KEY, credential TEXT NOT NULL)"
  );

  const read = (provider: string): Credential | undefined => {
    const row = db
      .prepare("SELECT credential FROM credentials WHERE provider = ?")
      .get(provider);

    return credentialRow.check(row)
      ? parseCredential(row.credential)
      : undefined;
  };

  const chains = new Map<string, Promise<void>>();

  const serialized = async <T>(
    provider: string,
    task: () => Promise<T>
  ): Promise<T> => {
    // A chain never rejects (see `ended`), so the task runs whether the write before it worked or failed.
    const next = (chains.get(provider) ?? Promise.resolve()).then(task);

    chains.set(provider, ended(next));

    return await next;
  };

  return {
    async read(provider) {
      return read(provider);
    },
    async list() {
      const rows = db
        .prepare("SELECT provider, credential FROM credentials")
        .all();

      return rows.flatMap((row): CredentialInfo[] =>
        providerRow.check(row)
          ? [
              {
                providerId: row.provider,
                type: parseCredential(row.credential).type,
              },
            ]
          : []
      );
    },
    async modify(provider, fn) {
      return await serialized(provider, async () => {
        const next = await fn(read(provider));

        if (next !== undefined) {
          db.prepare(
            "INSERT INTO credentials (provider, credential) VALUES (?, ?) ON CONFLICT (provider) DO UPDATE SET credential = excluded.credential"
          ).run(provider, JSON.stringify(next));
        }

        return read(provider);
      });
    },
    async delete(provider) {
      await serialized(provider, async () => {
        db.prepare("DELETE FROM credentials WHERE provider = ?").run(provider);
      });
    },
    close() {
      db.close();
    },
  };
}

/** Resolves once a write has ended, well or badly. */
async function ended(write: Promise<unknown>): Promise<void> {
  try {
    await write;
  } catch {
    // The write's caller hears of its failure; the next write for the provider only waits for it to end.
  }
}

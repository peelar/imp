// pi-ai's CredentialStore on the host's SQLite: model sign-ins survive restarts, and the file is readable by the host
// alone. Writes for one provider run one at a time, so a token refresh and a new sign-in cannot interleave.
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { CreateModelsOptions } from "@earendil-works/pi-ai/models";

// pi-ai does not export its auth types by name; these are the same types, read off createModels.
type CredentialStore = NonNullable<CreateModelsOptions["credentials"]>;
type Credential = NonNullable<Awaited<ReturnType<CredentialStore["read"]>>>;
type CredentialInfo = Awaited<ReturnType<CredentialStore["list"]>>[number];

export function openCredentialStore(path: string): CredentialStore & { close(): void } {
	const db = new DatabaseSync(path);
	chmodSync(path, 0o600);
	db.exec("CREATE TABLE IF NOT EXISTS credentials (provider TEXT PRIMARY KEY, credential TEXT NOT NULL)");
	const read = (provider: string): Credential | undefined => {
		const row = db.prepare("SELECT credential FROM credentials WHERE provider = ?").get(provider) as
			| { credential: string }
			| undefined;
		return row ? (JSON.parse(row.credential) as Credential) : undefined;
	};

	const chains = new Map<string, Promise<unknown>>();
	const serialized = <T>(provider: string, task: () => Promise<T>): Promise<T> => {
		const next = (chains.get(provider) ?? Promise.resolve()).then(task, task);
		chains.set(
			provider,
			next.catch(() => {}),
		);
		return next;
	};

	return {
		async read(provider) {
			return read(provider);
		},
		async list() {
			const rows = db.prepare("SELECT provider, credential FROM credentials").all() as {
				provider: string;
				credential: string;
			}[];
			return rows.map(
				(row): CredentialInfo => ({ providerId: row.provider, type: (JSON.parse(row.credential) as Credential).type }),
			);
		},
		modify(provider, fn) {
			return serialized(provider, async () => {
				const next = await fn(read(provider));
				if (next !== undefined) {
					db.prepare(
						"INSERT INTO credentials (provider, credential) VALUES (?, ?) ON CONFLICT (provider) DO UPDATE SET credential = excluded.credential",
					).run(provider, JSON.stringify(next));
				}
				return read(provider);
			});
		},
		delete(provider) {
			return serialized(provider, async () => {
				db.prepare("DELETE FROM credentials WHERE provider = ?").run(provider);
			});
		},
		close() {
			db.close();
		},
	};
}

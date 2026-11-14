// The vault for the owner's secrets: an OpenBao server the host runs and owns, in DATA_DIR/vault. The host starts it,
// it unseals itself from a key file beside its data (the static seal), and it sets itself up on its first start
// (declarative self-initialization): a KV store at secret/, an audit log of every request, and two policies.
//
//   imp-admin   what the host signs in with (Settings): it writes, lists and deletes secrets and reads their
//               descriptions, but cannot read a value back. A saved value is never shown again.
//   imp-egress  what the egress proxy gets (egress.ts): a short-lived token that only reads values.
//
// OpenBao takes requests on a unix socket only the host's user can open. Its storage (Raft) also needs a TCP cluster
// listener, so it listens on two loopback ports too, chosen once and kept: every request there still needs a token.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { tool } from "./tools.ts";

/** A secret as the vault describes it, without its value. */
export interface StoredSecret {
	readonly name: string;
	/** Strings only: OpenBao's custom metadata. */
	readonly meta: Readonly<Record<string, string>>;
	readonly created: string;
	readonly updated: string;
}

export interface VaultOptions {
	readonly dataDir: string;
	/** Where downloaded programs are kept (tools.ts). */
	readonly toolsDir: string;
}

const ADMIN_POLICY = `
path "secret/data/imp/*" { capabilities = ["create", "update", "delete"] }
path "secret/metadata/imp/*" { capabilities = ["read", "list", "update", "delete"] }
path "auth/token/create/imp-egress" { capabilities = ["update"] }
path "auth/token/revoke-accessor" { capabilities = ["update"] }
`;
const EGRESS_POLICY = `
path "secret/data/imp/*" { capabilities = ["read"] }
`;

const q = (value: string) => JSON.stringify(value);

function config(dir: string, ports: { api: number; cluster: number }): string {
	const file = (name: string) => join(dir, name);
	const read = (path: string) => `{ eval_source = "file", eval_type = "string", path = ${q(path)} }`;
	return `
storage "raft" {
  path = ${q(file("data"))}
  node_id = "imp"
}
listener "unix" {
  address = ${q(file("bao.sock"))}
  socket_mode = "0600"
}
listener "tcp" {
  address = "127.0.0.1:${ports.api}"
  cluster_address = "127.0.0.1:${ports.cluster}"
  tls_disable = true
}
api_addr = "http://127.0.0.1:${ports.api}"
cluster_addr = "http://127.0.0.1:${ports.cluster}"
disable_mlock = true
ui = false
seal "static" {
  current_key_id = "imp-1"
  current_key = ${q(`file://${file("seal.key")}`)}
}
audit "file" "audit" {
  options = { file_path = ${q(file("audit.log"))} }
}
initialize "imp" {
  request "kv" {
    operation = "update"
    path = "sys/mounts/secret"
    data = { type = "kv", options = { version = "2" } }
  }
  request "admin-policy" {
    operation = "update"
    path = "sys/policies/acl/imp-admin"
    data = { policy = ${read(file("imp-admin.hcl"))} }
  }
  request "egress-policy" {
    operation = "update"
    path = "sys/policies/acl/imp-egress"
    data = { policy = ${read(file("imp-egress.hcl"))} }
  }
  request "egress-role" {
    operation = "update"
    path = "auth/token/roles/imp-egress"
    data = { allowed_policies = ["imp-egress"], orphan = true, token_period = "1h" }
  }
  request "userpass" {
    operation = "update"
    path = "sys/auth/userpass"
    data = { type = "userpass" }
  }
  request "host-user" {
    operation = "update"
    path = "auth/userpass/users/host"
    data = { password = ${read(file("host.pass"))}, token_policies = ["imp-admin"] }
  }
}
`;
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
		});
	});
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const children = new Set<ChildProcess>();
process.once("exit", () => {
	for (const child of children) child.kill();
});

export function openVault(options: VaultOptions) {
	const dir = join(options.dataDir, "vault");
	const socket = join(dir, "bao.sock");
	const log = join(dir, "bao.log");
	let child: ChildProcess | undefined;
	let starting: Promise<void> | undefined;
	let token = "";
	let closed = false;
	let status = "stopped";
	let error = "";

	/** One request to OpenBao's API on its socket: the JSON it answered (undefined for none) and its status. */
	function call(method: string, path: string, body?: unknown, auth = token): Promise<{ status: number; json: any }> {
		return new Promise((resolve, reject) => {
			const payload = body === undefined ? undefined : JSON.stringify(body);
			const req = request(
				{
					socketPath: socket,
					method,
					path: `/v1/${path}`,
					headers: { ...(auth ? { "x-vault-token": auth } : {}), ...(payload ? { "content-type": "application/json" } : {}) },
					timeout: 30_000,
				},
				(res) => {
					let text = "";
					res.setEncoding("utf8");
					res.on("data", (chunk) => (text += chunk));
					res.on("end", () => {
						try {
							resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined });
						} catch {
							resolve({ status: res.statusCode ?? 0, json: { errors: [text] } });
						}
					});
				},
			);
			req.on("timeout", () => req.destroy(new Error("OpenBao did not answer")));
			req.on("error", reject);
			req.end(payload);
		});
	}

	/** Writes what OpenBao starts from, once: the seal key, the host's password, the policies and two ports. */
	async function prepare() {
		mkdirSync(join(dir, "data"), { recursive: true, mode: 0o700 });
		const once = (name: string, content: string | Buffer) => {
			const path = join(dir, name);
			if (!existsSync(path)) writeFileSync(path, content, { mode: 0o600 });
		};
		once("seal.key", randomBytes(32));
		// No newline: self-initialization reads the file byte for byte.
		once("host.pass", randomBytes(24).toString("hex"));
		once("imp-admin.hcl", ADMIN_POLICY);
		once("imp-egress.hcl", EGRESS_POLICY);
		// Raft keeps the node's cluster address, so the ports are chosen once and kept.
		const portsFile = join(dir, "ports.json");
		if (!existsSync(portsFile)) {
			const api = await freePort();
			let cluster = await freePort();
			while (cluster === api) cluster = await freePort();
			writeFileSync(portsFile, JSON.stringify({ api, cluster }), { mode: 0o600 });
		}
		const ports = JSON.parse(readFileSync(portsFile, "utf8")) as { api: number; cluster: number };
		writeFileSync(join(dir, "bao.hcl"), config(dir, ports), { mode: 0o600 });
	}

	async function start() {
		status = "starting";
		error = "";
		const bao = await tool(options.toolsDir, "bao");
		await prepare();
		appendFileSync(log, `\n--- ${new Date().toISOString()} starting OpenBao\n`);
		const process_ = spawn(bao, ["server", `-config=${join(dir, "bao.hcl")}`], {
			stdio: ["ignore", "pipe", "pipe"],
			// Only what it needs: OpenBao prints the names of the variables it sees.
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
		});
		children.add(process_);
		process_.stdout!.on("data", (chunk) => appendFileSync(log, chunk));
		process_.stderr!.on("data", (chunk) => appendFileSync(log, chunk));
		process_.on("exit", (code) => {
			children.delete(process_);
			if (child !== process_) return;
			child = undefined;
			token = "";
			if (!closed) {
				status = "failed";
				error = `OpenBao stopped (exit ${code}). Its log is ${log}.`;
			}
		});
		child = process_;
		// Unsealed and set up: the host signs in, which needs self-initialization to have created its user.
		for (let i = 0; i < 360; i++) {
			if (child !== process_) break;
			try {
				const health = await call("GET", "sys/health", undefined, "");
				if (health.status === 200 && (await login())) {
					status = "ready";
					return;
				}
			} catch {
				// The socket is not there yet.
			}
			await sleep(250);
		}
		const tail = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").slice(-5).join("\n") : "";
		process_.kill();
		throw new Error(`OpenBao did not start. ${tail}`);
	}

	async function login(): Promise<boolean> {
		const password = readFileSync(join(dir, "host.pass"), "utf8");
		const answer = await call("POST", "auth/userpass/login/host", { password }, "");
		token = answer.json?.auth?.client_token ?? "";
		return token !== "";
	}

	/** OpenBao, started if it is not running, with the host signed in. */
	function ready(): Promise<void> {
		if (closed) return Promise.reject(new Error("The vault is closed."));
		if (child && token) return Promise.resolve();
		return (starting ??= start()
			.catch((failure: unknown) => {
				status = "failed";
				error = failure instanceof Error ? failure.message : String(failure);
				throw failure;
			})
			.finally(() => {
				starting = undefined;
			}));
	}

	/** A request as the host; signs in again once if its token has expired. A 404 answers undefined. */
	async function admin(method: string, path: string, body?: unknown): Promise<any> {
		await ready();
		let answer = await call(method, path, body);
		if (answer.status === 403 && (await login())) answer = await call(method, path, body);
		if (answer.status === 404) return undefined;
		if (answer.status >= 400) {
			const reason = (answer.json?.errors ?? []).join("; ") || `status ${answer.status}`;
			throw new Error(`OpenBao refused ${method} ${path}: ${reason}`);
		}
		return answer.json;
	}

	const path = (name: string) => `imp/${name}`;

	return {
		/** "stopped", "starting", "ready", or "failed" (with `error`). */
		state: () => ({ status, error }),
		socket,
		ready,
		async list(): Promise<StoredSecret[]> {
			// No secret yet: the path does not exist (404).
			const listed = await admin("GET", "secret/metadata/imp?list=true");
			const names: string[] = listed?.data?.keys ?? [];
			return Promise.all(
				names.map(async (name) => {
					const data = (await admin("GET", `secret/metadata/${path(name)}`))?.data;
					return {
						name,
						meta: (data?.custom_metadata ?? {}) as Record<string, string>,
						created: String(data?.created_time ?? ""),
						updated: String(data?.updated_time ?? ""),
					};
				}),
			);
		},
		/** Stores a new value (an empty one keeps the current value) and replaces the description. */
		async put(name: string, value: string, meta: Record<string, string>) {
			if (value !== "") await admin("POST", `secret/data/${path(name)}`, { data: { value } });
			await admin("POST", `secret/metadata/${path(name)}`, { custom_metadata: meta });
		},
		/** Removes a secret and every version of its value. */
		async remove(name: string) {
			await admin("DELETE", `secret/metadata/${path(name)}`);
		},
		/** A new token that can only read values, valid for an hour unless renewed. */
		async egressToken(): Promise<{ token: string; accessor: string }> {
			const answer = await admin("POST", "auth/token/create/imp-egress", {});
			return { token: answer.auth.client_token, accessor: answer.auth.accessor };
		},
		async revoke(accessor: string) {
			await admin("POST", "auth/token/revoke-accessor", { accessor });
		},
		close() {
			closed = true;
			child?.kill();
			child = undefined;
		},
	};
}

export type Vault = ReturnType<typeof openVault>;

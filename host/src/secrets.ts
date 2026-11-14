// The owner's secrets: API keys their imp uses on its computer without holding them. The owner adds them in Settings,
// the vault keeps them (vault.ts), and the egress proxy puts each one on the agent's HTTPS requests to its hosts
// (egress.ts). On the machine a secret is only a stand-in, in the environment variables its service's tools read, such
// as GITHUB_TOKEN=imp-secret-github. The agent sees names and hosts, never a value, and asks the owner for a secret it
// lacks with request_secret, never in the chat.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineExtension, defineTool, type Registry, section } from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { openEgress, type EgressRule, type EgressUse } from "./egress.ts";
import type { Topics } from "./live.ts";
import type { Machine } from "./machine.ts";
import { openVault, type StoredSecret } from "./vault.ts";

export const TOPIC = "secrets";
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const HEADER = /^[A-Za-z0-9-]{1,64}$/;
const USES_KEPT = 200;
const USES_SHOWN = 12;

type HostRule = Omit<EgressRule, "secret"> & { readonly host: string };

/** A service the owner picks when adding a key: where its tools send it, and the variables they read it from. */
interface Service {
	readonly id: string;
	readonly label: string;
	readonly rules: readonly HostRule[];
	readonly env: readonly string[];
}

const bearer = (host: string): HostRule => ({ host, header: "Authorization", prefix: "Bearer " });

export const SERVICES: readonly Service[] = [
	{
		id: "github",
		label: "GitHub",
		// The API and gh take a bearer token; git over HTTPS to github.com takes it as basic auth.
		rules: [
			bearer("api.github.com"),
			bearer("uploads.github.com"),
			{ host: "github.com", header: "Authorization", prefix: "Basic ", basicUser: "x-access-token" },
		],
		env: ["GITHUB_TOKEN", "GH_TOKEN"],
	},
	{ id: "openai", label: "OpenAI", rules: [bearer("api.openai.com")], env: ["OPENAI_API_KEY"] },
	{ id: "anthropic", label: "Anthropic", rules: [{ host: "api.anthropic.com", header: "x-api-key", prefix: "" }], env: ["ANTHROPIC_API_KEY"] },
	{ id: "linear", label: "Linear", rules: [{ host: "api.linear.app", header: "Authorization", prefix: "" }], env: ["LINEAR_API_KEY"] },
];

export interface SecretView {
	name: string;
	service: string;
	label: string;
	hosts: string;
	env: string;
	standIn: string;
	updated: string;
	lastUsed: string;
}

export interface SecretsState {
	/** "starting" (the vault is being set up), "ready", or "failed" (with `error`). */
	status: string;
	error: string;
	secrets: SecretView[];
	requests: { id: string; name: string; service: string; why: string; host: string }[];
	uses: { id: string; secret: string; what: string; status: number; failed: boolean; when: string }[];
	services: { id: string; label: string; hosts: string; env: string }[];
}

/** A secret's description, as the vault keeps it (strings only). */
interface Described {
	readonly name: string;
	readonly service: string;
	readonly rules: readonly HostRule[];
	readonly env: readonly string[];
	readonly standIn: string;
	readonly updated: string;
}

const standInFor = (name: string) => `imp-secret-${name}`;
const envFor = (name: string) => `${name.toUpperCase().replace(/-/g, "_")}_API_KEY`;

function described(stored: StoredSecret): Described | undefined {
	try {
		return {
			name: stored.name,
			service: stored.meta.service ?? "other",
			rules: JSON.parse(stored.meta.rules ?? "[]") as HostRule[],
			env: (stored.meta.env ?? "").split(",").filter(Boolean),
			standIn: stored.meta.standIn ?? standInFor(stored.name),
			updated: stored.updated,
		};
	} catch {
		return undefined;
	}
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
function ago(iso: string, now = Date.now()): string {
	const ms = now - Date.parse(iso);
	if (!Number.isFinite(ms)) return "";
	if (ms < 60_000) return "just now";
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
	if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ago`;
	const days = Math.floor(ms / 86_400_000);
	return days === 1 ? "yesterday" : `${days} days ago`;
}

export interface SecretsOptions {
	readonly dataDir: string;
	readonly toolsDir: string;
	readonly topics: Topics;
	readonly registry: Registry;
	/** The agent's current machine, started if it must be. */
	readonly machine: () => Promise<Machine>;
}

export function openSecrets(options: SecretsOptions) {
	const vault = openVault({ dataDir: options.dataDir, toolsDir: options.toolsDir });
	const usesFile = join(options.dataDir, "secrets-uses.json");
	const requestsFile = join(options.dataDir, "secrets-requests.json");
	const readJson = <T>(file: string, fallback: T): T => {
		try {
			return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
		} catch {
			return fallback;
		}
	};
	let uses = readJson<(EgressUse & { id: string; at: string })[]>(usesFile, []);
	let requests = readJson<SecretsState["requests"]>(requestsFile, []);
	let secrets: Described[] = [];
	let loaded: Promise<void> | undefined;
	/** Whether the secrets have been read from the vault since the host started. */
	let listed = false;
	const changed = () => options.topics.changed(TOPIC);

	const egress = openEgress({
		dataDir: options.dataDir,
		toolsDir: options.toolsDir,
		vault,
		onUse(use) {
			uses = [...uses, { ...use, id: randomUUID(), at: new Date().toISOString() }].slice(-USES_KEPT);
			writeFileSync(usesFile, JSON.stringify(uses), { mode: 0o600 });
			changed();
		},
	});

	/** Reads the secrets' descriptions from the vault, and gives the egress proxy their rules. */
	async function reload() {
		secrets = (await vault.list()).flatMap((s) => described(s) ?? []).sort((a, b) => a.name.localeCompare(b.name));
		const hosts: Record<string, EgressRule[]> = {};
		for (const secret of secrets) {
			for (const { host, ...rule } of secret.rules) (hosts[host] ??= []).push({ secret: secret.name, ...rule });
		}
		egress.setRules({ hosts, standIns: Object.fromEntries(secrets.map((s) => [s.name, s.standIn])) });
		listed = true;
		changed();
	}

	/** The vault running and the secrets read, once; a failure is shown in Settings and tried again on the next call. */
	function load(): Promise<void> {
		return (loaded ??= reload().catch((failure: unknown) => {
			loaded = undefined;
			changed();
			throw failure;
		}));
	}

	const ok = { ok: true, error: "" };
	const refused = (error: string) => ({ ok: false, error });

	// The agent's side: what it may use, and how to ask for more.
	options.registry.install(
		defineExtension({
			name: "secrets",
			sections: [
				section("secrets", () => {
					const rule =
						"Never ask the user for a key's value or to paste one in the chat. If a task needs a key that is not listed, call request_secret: the user adds it in Settings, where you never see it.";
					if (secrets.length === 0) return `The user has no secrets yet. ${rule}`;
					const list = secrets.map(
						(s) => `- ${s.name}: ${s.env.map((e) => `$${e}`).join(", ")}, for ${s.rules.map((r) => r.host).join(", ")}`,
					);
					return `The user's secrets, which work on your computer without you seeing them:\n${list.join("\n")}\nUse each variable as if it held the real key, with any tool (curl, gh, git, SDKs): it holds a stand-in, and Imp's host puts the real key on your HTTPS requests to the hosts listed. It does nothing anywhere else, so don't print it or copy it elsewhere. ${rule}`;
				}),
			],
			tools: [
				defineTool({
					name: "request_secret",
					description:
						"Ask the user to add an API key you need, such as a GitHub token. They see the request in Settings, with the form filled in; you never see the key, and you can use it once they add it (it shows in your secrets).",
					parameters: obj({
						service: oneOf([...SERVICES.map((s) => s.id), "other"], { description: "The service, or \"other\"." }),
						why: str({ description: "What you need it for, in a sentence the user reads." }),
						name: opt(str({ description: "A short lowercase name, such as \"github\". Default: the service." })),
						host: opt(str({ description: "For \"other\": the API's host name, such as \"api.example.com\"." })),
					}),
					execute: async ({ service, why, name, host }: { service: string; why: string; name?: string; host?: string }) => {
						const id = (name ?? (service === "other" ? (host ?? "").split(".").at(-2) : service) ?? "").toLowerCase();
						if (!NAME.test(id)) return text("Give the secret a short lowercase name, such as \"github\".");
						if (secrets.some((s) => s.name === id)) return text(`The user already has ${id}. Use it as your secrets section says.`);
						requests = [...requests.filter((r) => r.name !== id), { id: randomUUID(), name: id, service, why, host: host ?? "" }];
						writeFileSync(requestsFile, JSON.stringify(requests), { mode: 0o600 });
						changed();
						return text(`Asked. The user sees your request for ${id} in Settings → Secrets. Tell them, then wait: it shows in your secrets once they add it.`);
					},
				}),
			],
		}),
	);

	return {
		/** Starts the vault in the background, so Settings has the secrets when it opens. */
		start() {
			void load().catch((failure) => console.error(`secrets: ${failure instanceof Error ? failure.message : failure}`));
		},
		/** What Settings shows. */
		state(): SecretsState {
			const vaultState = vault.state();
			const lastUse = new Map(uses.map((u) => [u.secret, u.at]));
			return {
				status: vaultState.status === "failed" ? "failed" : listed ? "ready" : "starting",
				error: vaultState.error,
				secrets: secrets.map((s) => ({
					name: s.name,
					service: s.service,
					label: SERVICES.find((x) => x.id === s.service)?.label ?? s.name,
					hosts: s.rules.map((r) => r.host).join(", "),
					env: s.env.map((e) => `$${e}`).join(", "),
					standIn: s.standIn,
					updated: ago(s.updated),
					lastUsed: lastUse.has(s.name) ? ago(lastUse.get(s.name)!) : "",
				})),
				requests,
				uses: uses
					.slice(-USES_SHOWN)
					.reverse()
					.map((u) => ({
						id: u.id,
						secret: u.secret,
						what: `${u.method} ${u.host}${u.path}`,
						status: u.status,
						failed: u.status === 0 || u.status >= 400,
						when: ago(u.at),
					})),
				services: SERVICES.map((s) => ({ id: s.id, label: s.label, hosts: s.rules.map((r) => r.host).join(", "), env: s.env.map((e) => `$${e}`).join(", ") })),
			};
		},
		/**
		 * Adds a secret, or replaces one's value (an empty value keeps it). For "other", `hosts` (comma-separated),
		 * `header`, `prefix` and `envName` say where it goes; a service fills them in itself.
		 */
		async put(input: { name: string; service: string; value: string; hosts: string; header: string; prefix: string; envName: string }) {
			const name = input.name.trim().toLowerCase();
			const value = input.value.trim();
			if (!NAME.test(name)) return refused("Name it with lowercase letters, digits and dashes, such as github.");
			const existing = secrets.find((s) => s.name === name);
			if (!existing && value === "") return refused("Paste the key first.");
			if (/[\r\n]/.test(value)) return refused("A key is one line.");
			let rules: HostRule[];
			let env: string[];
			const service = SERVICES.find((s) => s.id === input.service);
			if (service) {
				rules = [...service.rules];
				env = [...service.env];
			} else if (input.service === "other" && existing?.service === "other" && input.hosts.trim() === "") {
				// A new value for a key the owner added: it keeps where it goes.
				rules = [...existing.rules];
				env = [...existing.env];
			} else if (input.service === "other") {
				const hosts = input.hosts.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
				if (hosts.length === 0 || !hosts.every((h) => HOST.test(h))) return refused("Name the hosts the key is for, such as api.example.com.");
				const header = input.header.trim() || "Authorization";
				if (!HEADER.test(header)) return refused(`${header} is not a header name.`);
				const envName = input.envName.trim() || envFor(name);
				if (!ENV_NAME.test(envName)) return refused(`${envName} is not a variable name: use capitals, digits and _.`);
				rules = hosts.map((host) => ({ host, header, prefix: input.prefix }));
				env = [envName];
			} else {
				return refused(`There is no service ${input.service}.`);
			}
			const others = secrets.filter((s) => s.name !== name);
			const clash = others.find((s) => s.env.some((e) => env.includes(e)));
			if (clash) return refused(`${clash.name} already uses ${clash.env.find((e) => env.includes(e))}.`);
			const taken = others.find((s) => s.rules.some((r) => rules.some((x) => x.host === r.host && x.header.toLowerCase() === r.header.toLowerCase())));
			if (taken) return refused(`${taken.name} already goes on ${taken.rules.map((r) => r.host).join(", ")}.`);
			try {
				await load();
				await vault.put(name, value, { service: input.service, rules: JSON.stringify(rules), env: env.join(","), standIn: standInFor(name) });
				requests = requests.filter((r) => r.name !== name);
				writeFileSync(requestsFile, JSON.stringify(requests), { mode: 0o600 });
				await reload();
				return ok;
			} catch (failure) {
				return refused(failure instanceof Error ? failure.message : String(failure));
			}
		},
		async remove(name: string) {
			try {
				await load();
				await vault.remove(name);
				await reload();
				return ok;
			} catch (failure) {
				return refused(failure instanceof Error ? failure.message : String(failure));
			}
		},
		dismiss(id: string) {
			requests = requests.filter((r) => r.id !== id);
			writeFileSync(requestsFile, JSON.stringify(requests), { mode: 0o600 });
			changed();
			return ok;
		},
		/**
		 * What every command on the machine gets in its environment: each secret's stand-in, and the egress proxy with the
		 * control socket to the machine open. Nothing, and no machine started, while there are no secrets.
		 */
		async shellEnv(): Promise<Record<string, string>> {
			await load().catch(() => {});
			if (secrets.length === 0) return {};
			const standIns = Object.fromEntries(secrets.flatMap((s) => s.env.map((e) => [e, s.standIn])));
			try {
				const machine = await options.machine();
				const [{ env }] = await Promise.all([machine.egress(), egress.connect(machine)]);
				return { ...env, ...standIns };
			} catch (failure) {
				// The command still runs; its requests to a secret's hosts fail with the proxy's reason.
				console.error(`secrets: ${failure instanceof Error ? failure.message : failure}`);
				return standIns;
			}
		},
		/** The agent moved to another machine. */
		switched() {
			egress.disconnect();
		},
		close() {
			egress.close();
			vault.close();
		},
	};
}

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

export type Secrets = ReturnType<typeof openSecrets>;

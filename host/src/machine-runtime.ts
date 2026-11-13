// The machine runtime: what the host installs on every machine, whatever the provider. One agentd process serves
// pi-env and the app daemon on one port (see machine/agentd.mjs). Adapters copy these files, start agentd, and check
// its health; nothing here depends on the provider.
import { createHash, createHmac } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { packagedDaemon } from "@earendil-works/pi-env";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const MACHINE_SOURCES = join(here, "..", "machine");
const WS_PACKAGE = dirname(require.resolve("ws/package.json"));
const BRIDGE_CLIENT = join(here, "bridge-client.mjs");

export const AGENTD_PORT = 7070;

export interface Runtime {
	readonly files: readonly RuntimeFile[];
	/** Changes whenever any file does. */
	readonly digest: string;
}

export interface RuntimeFile {
	/** Relative to the runtime directory on the machine. */
	readonly path: string;
	readonly data: Buffer;
	readonly executable?: boolean;
}

/** Every file agentd needs, for a machine of this platform. */
export async function runtime(platform: { platform: "linux" | "darwin"; arch: "x64" | "arm64" }): Promise<Runtime> {
	const files: RuntimeFile[] = [
		{ path: "pi-env", data: await readFile(packagedDaemon(platform)), executable: true },
		{ path: "agentd.mjs", data: await readFile(join(MACHINE_SOURCES, "agentd.mjs")) },
		{ path: "worker.mjs", data: await readFile(join(MACHINE_SOURCES, "worker.mjs")) },
	];
	for (const file of await listFiles(WS_PACKAGE)) {
		files.push({ path: `node_modules/ws/${relative(WS_PACKAGE, file)}`, data: await readFile(file) });
	}
	const hash = createHash("sha256");
	for (const file of files) hash.update(file.path).update("\0").update(file.data).update("\0");
	return { files, digest: hash.digest("hex").slice(0, 16) };
}

/** The environment agentd starts with. */
export function agentdEnv(options: { token: string; digest: string; runtimeDir: string; home: string; host?: string }) {
	return {
		AGENTD_TOKEN: options.token,
		AGENTD_DIGEST: options.digest,
		AGENTD_PORT: String(AGENTD_PORT),
		PI_ENV_PATH: join(options.runtimeDir, "pi-env"),
		MACHINE_HOME: options.home,
		...(options.host ? { AGENTD_HOST: options.host } : {}),
	};
}

/** Each machine's token: derived from the host secret, so the host needs to store nothing per machine. */
export const agentdToken = (secret: string, machineId: string) =>
	createHmac("sha256", secret).update(`agentd:${machineId}`).digest("hex");

/** What a healthy agentd started with `token` and this runtime answers on /health. */
export const healthFor = (token: string, digest: string) => createHash("sha256").update(`${token}:${digest}`).digest("hex");

/** The two endpoints every machine offers, given the base URL that reaches agentd's port. */
export function agentdEndpoints(base: { url: string; headers: Readonly<Record<string, string>> }, token: string) {
	const ws = base.url.replace(/^http/, "ws");
	return {
		/** pi-env's Connection appends `serve --token <hex>` to this command. */
		daemonCommand: [process.execPath, BRIDGE_CLIENT, `${ws}/pi-env?token=${token}`, JSON.stringify(base.headers)],
		appSocket: { url: `${ws}/apps?token=${token}`, headers: base.headers },
	};
}

async function listFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await listFiles(path)));
		else out.push(path);
	}
	return out;
}

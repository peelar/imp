// The E2B adapter. A machine is one E2B sandbox, found by its `machineKey` metadata. It pauses itself when idle,
// keeping memory and disk, and wakes on the next request to one of its URLs.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Sandbox, Template } from "e2b";
import type { ImageSpec, Machine, MachineProvider, MachineSpec } from "./machine.ts";
import { AGENTD_PORT, agentdEndpoints, agentdEnv, agentdToken, healthFor, runtime, type Runtime } from "./machine-runtime.ts";

const HOME = "/home/user";
const RUNTIME_DIR = `${HOME}/.imp`;

export interface E2BProviderOptions {
	/** Signs per-machine tokens; keep it stable across host restarts. */
	readonly secret: string;
	readonly apiKey?: string;
}

export function e2bProvider(options: E2BProviderOptions): MachineProvider {
	const api = options.apiKey === undefined ? {} : { apiKey: options.apiKey };
	let files: Promise<Runtime> | undefined;

	async function find(key: string) {
		const pages = Sandbox.list({ ...api, query: { metadata: { machineKey: key }, state: ["running", "paused"] } });
		const items = pages.hasNext ? await pages.nextItems() : [];
		return items[0];
	}

	return {
		name: "e2b",
		workspace: () => `${HOME}/workspace`,

		async prepareImage(image: ImageSpec) {
			const dockerfile = await readFile(join(image.context, image.dockerfile), "utf8");
			const name = `imp-machine-${createHash("sha256").update(dockerfile).digest("hex").slice(0, 12)}`;
			if (!(await Template.exists(name, api))) await Template.build(Template().fromDockerfile(dockerfile), name, api);
			return name;
		},

		async ensure(spec: MachineSpec) {
			const existing = await find(spec.key);
			const sandbox = existing
				? await Sandbox.connect(existing.sandboxId, { ...api, timeoutMs: spec.idleSuspendMs })
				: await Sandbox.create(spec.image, {
						...api,
						metadata: { machineKey: spec.key },
						timeoutMs: spec.idleSuspendMs,
						lifecycle: { onTimeout: "pause", autoResume: true },
						network: { allowPublicTraffic: false },
					});
			const token = agentdToken(options.secret, sandbox.sandboxId);
			await startAgentd(sandbox, token, await (files ??= runtime({ platform: "linux", arch: "x64" })));
			return e2bMachine(spec, sandbox, token);
		},

		async destroy(key: string) {
			const existing = await find(key);
			if (existing) await Sandbox.kill(existing.sandboxId, api);
		},
	};
}

function e2bMachine(spec: MachineSpec, sandbox: Sandbox, token: string): Machine {
	// Sandbox URLs refuse requests without this header (allowPublicTraffic: false).
	const headers: Record<string, string> = sandbox.trafficAccessToken
		? { "e2b-traffic-access-token": sandbox.trafficAccessToken }
		: {};
	const endpoints = agentdEndpoints({ url: `https://${sandbox.getHost(AGENTD_PORT)}`, headers }, token);
	return {
		key: spec.key,
		async daemonCommand() {
			return endpoints.daemonCommand;
		},
		async appSocket() {
			return endpoints.appSocket;
		},
		async expose(port: number) {
			return { url: `https://${sandbox.getHost(port)}`, headers };
		},
		async keepAlive() {
			await sandbox.setTimeout(spec.idleSuspendMs);
		},
		async suspend() {
			await sandbox.pause();
		},
	};
}

/** Installs the runtime and (re)starts agentd, unless one with this token and runtime already answers. */
async function startAgentd(sandbox: Sandbox, token: string, { files, digest }: Runtime): Promise<void> {
	const expected = healthFor(token, digest);
	const health = () => sandbox.commands.run(`curl -sf http://127.0.0.1:${AGENTD_PORT}/health || true`);
	const answer = (await health()).stdout.trim();
	if (answer === expected) return;
	if (answer !== "") {
		// Another runtime holds the port (an older version, or one started with another token). Everything run from the
		// runtime directory is ours, so stop all of it, pi-env daemons included, and wait for the port to free up.
		const ours = `${RUNTIME_DIR.slice(0, -1)}[${RUNTIME_DIR.slice(-1)}]/`;
		await sandbox.commands.run(
			`pkill -f "${ours}" || true; for i in $(seq 50); do curl -s -o /dev/null http://127.0.0.1:${AGENTD_PORT}/ || exit 0; sleep 0.1; done; exit 1`,
		);
	}

	await sandbox.files.write(files.map((file) => ({ path: `${RUNTIME_DIR}/${file.path}`, data: toArrayBuffer(file.data) })));
	const executables = files.filter((file) => file.executable).map((file) => `${RUNTIME_DIR}/${file.path}`);
	await sandbox.commands.run(`chmod +x ${executables.join(" ")} && mkdir -p ${HOME}/workspace`);
	await sandbox.commands.run(`node ${RUNTIME_DIR}/agentd.mjs >> ${RUNTIME_DIR}/agentd.log 2>&1`, {
		background: true,
		envs: agentdEnv({ token, digest, runtimeDir: RUNTIME_DIR, home: HOME }),
	});
	for (let i = 0; i < 50; i++) {
		if ((await health()).stdout.trim() === expected) return;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	const log = await sandbox.commands.run(`tail -n 50 ${RUNTIME_DIR}/agentd.log || true`);
	throw new Error(`agentd did not start: ${log.stdout}`);
}

const toArrayBuffer = (buffer: Buffer): ArrayBuffer =>
	buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

// The local adapter: the "machine" is a directory on the host and agentd a child process of the host. It isolates
// nothing, so it is for development and tests only; the E2B adapter is the one to give an agent your accounts with.
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import type { Machine, MachineProvider, MachineSpec } from "./machine.ts";
import { agentdEndpoints, agentdEnv, agentdToken, healthFor, runtime, type Runtime } from "./machine-runtime.ts";

export interface LocalProviderOptions {
	readonly secret: string;
	/** Each machine is a directory under this one. */
	readonly dir: string;
}

export function localProvider(options: LocalProviderOptions): MachineProvider {
	const running = new Map<string, { child: ChildProcess; port: number; token: string }>();
	// A local machine lives as long as its host: agentd is a child process, so stop it when the host exits.
	process.once("exit", () => {
		for (const { child } of running.values()) child.kill();
	});
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => process.exit(128 + (signal === "SIGINT" ? 2 : 15)));
	}
	let files: Promise<Runtime> | undefined;
	const dirFor = (key: string) => join(options.dir, key.replace(/[^a-zA-Z0-9_-]/g, "_"));
	const home = (key: string) => join(dirFor(key), "home");

	return {
		name: "local",
		workspace: (key) => join(home(key), "workspace"),
		async prepareImage() {
			return "local";
		},

		async ensure(spec: MachineSpec) {
			const token = agentdToken(options.secret, `local:${spec.key}`);
			const { files: list, digest } = await (files ??= runtime({
				platform: process.platform === "darwin" ? "darwin" : "linux",
				arch: process.arch === "arm64" ? "arm64" : "x64",
			}));
			let current = running.get(spec.key);
			if (!current || current.child.exitCode !== null || !(await healthy(current.port, healthFor(token, digest)))) {
				current?.child.kill();
				const runtimeDir = join(dirFor(spec.key), "runtime");
				for (const file of list) {
					const path = join(runtimeDir, file.path);
					await mkdir(dirname(path), { recursive: true });
					await writeFile(path, file.data);
					if (file.executable) await chmod(path, 0o755);
				}
				await mkdir(join(home(spec.key), "workspace"), { recursive: true });
				const port = await freePort();
				const child = spawn(process.execPath, [join(runtimeDir, "agentd.mjs")], {
					env: {
						...process.env,
						...agentdEnv({ token, digest, runtimeDir, home: home(spec.key), host: "127.0.0.1" }),
						AGENTD_PORT: String(port),
						HOME: home(spec.key),
					},
					stdio: ["ignore", "inherit", "inherit"],
				});
				current = { child, port, token };
				running.set(spec.key, current);
				let up = false;
				for (let i = 0; i < 100 && !up; i++) {
					up = await healthy(port, healthFor(token, digest));
					if (!up) await new Promise((resolve) => setTimeout(resolve, 50));
				}
				if (!up) throw new Error("agentd did not start on the local machine");
			}
			const endpoints = agentdEndpoints({ url: `http://127.0.0.1:${current.port}`, headers: {} }, token);
			const machine: Machine = {
				key: spec.key,
				daemonCommand: async () => endpoints.daemonCommand,
				appSocket: async () => endpoints.appSocket,
				expose: async (port) => ({ url: `http://127.0.0.1:${port}`, headers: {} }),
				keepAlive: async () => {},
				suspend: async () => {},
			};
			return machine;
		},

		async destroy(key: string) {
			running.get(key)?.child.kill();
			running.delete(key);
			await rm(dirFor(key), { recursive: true, force: true });
		},
	};
}

async function healthy(port: number, expected: string): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/health`);
		return (await response.text()) === expected;
	} catch {
		return false;
	}
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

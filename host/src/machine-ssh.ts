// The SSH adapter: the agent's computer is one you bring, such as a home lab box, a VM on this computer (Lima,
// Multipass, OrbStack, WSL), or a cloud VM you rent. The host reaches it with the system `ssh`, as a user with
// passwordless sudo (or root). Settings reach it over Tailscale SSH (see tailnet.ts), which authenticates both ends
// with their tailnet identities; the adapter itself only needs `ssh` to get in. Over SSH the host runs the setup when the machine has not run this version, keeps the runtime in
// ~/.imp, and starts agentd on the machine's loopback. It reaches agentd and every exposed port through SSH tunnels it
// opens itself, so nothing on the machine listens on the network. Tailscale (or Tailscale SSH) is one way to reach it.
//
// The computer is yours: it never suspends, `keepAlive()` and `suspend()` do nothing, and `destroy()` removes only
// what the host put in ~/.imp.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ImageSpec, Machine, MachineProvider, MachineSpec } from "./machine.ts";
import {
	AGENTD_PORT,
	agentdEndpoints,
	agentdEnv,
	agentdToken,
	egressEnv,
	healthFor,
	runtime,
	runtimePattern,
	SETUP_MARKER,
	setupScript,
	type Runtime,
} from "./machine-runtime.ts";

export interface SshTargetOptions {
	/** `user@host` or `user@host:port`. The host may be a ~/.ssh/config alias. */
	readonly target: string;
	readonly identityFile?: string;
	/** The host keys to trust, under `hostKeyAlias`; without it, ~/.ssh/known_hosts. */
	readonly knownHostsFile?: string;
	readonly hostKeyAlias?: string;
	/** How `ssh` reaches the machine, such as `tailscale nc %h %p`. */
	readonly proxyCommand?: string;
	/** The user's home directory on the machine. Default: /root for root, else /home/<user>. */
	readonly home?: string;
}

export interface SshProviderOptions extends SshTargetOptions {
	/** Signs per-machine tokens; keep it stable across host restarts. */
	readonly secret: string;
}

interface Tunnel {
	readonly port: number;
	readonly child: ChildProcess;
}

/** `user@host[:port]`, split. */
export function parseSshTarget(target: string): { user?: string; host: string; port?: number } | undefined {
	const match = /^(?:([^@\s]+)@)?([^@:\s]+)(?::(\d{1,5}))?$/.exec(target);
	if (!match) return undefined;
	return { user: match[1], host: match[2]!, port: match[3] ? Number(match[3]) : undefined };
}

/** How to reach the target with `ssh`: its destination, the options before it, and the user's home there. */
function sshTarget(options: SshTargetOptions) {
	const parsed = parseSshTarget(options.target);
	if (!parsed) throw new Error(`The SSH target must look like user@host or user@host:port, not ${options.target}`);
	const { user, host, port } = parsed;
	const home = options.home ?? (user === "root" ? "/root" : user ? `/home/${user}` : "");
	if (!home) throw new Error("Name the SSH user (user@host) or the machine's home directory");
	const args = [
		...["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"],
		...["-o", "ForwardAgent=no", "-o", "ForwardX11=no"],
		...(port ? ["-p", String(port)] : []),
		...(options.identityFile ? ["-i", options.identityFile, "-o", "IdentitiesOnly=yes"] : []),
		...(options.knownHostsFile
			? [
					...["-o", `UserKnownHostsFile=${options.knownHostsFile}`, "-o", "GlobalKnownHostsFile=none"],
					...["-o", "StrictHostKeyChecking=yes", "-o", `HostKeyAlias=${options.hostKeyAlias ?? host}`],
				]
			: []),
		...(options.proxyCommand ? ["-o", `ProxyCommand=${options.proxyCommand}`] : []),
	];
	return { destination: user ? `${user}@${host}` : host, args, home };
}

/** Runs `command` with the login user's shell on the machine; `input` is its stdin. */
function runSsh(
	target: { destination: string; args: string[] },
	command: string,
	input?: string | Buffer,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", [...target.args, "-T", target.destination, command], { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
		child.stdin.end(input);
	});
}

/** Signs in to the target and checks it can be a machine: its home directory, or why it cannot. */
export async function probeSsh(options: SshTargetOptions): Promise<{ home: string } | { error: string; denied?: true }> {
	const target = sshTarget({ ...options, home: options.home ?? "/" });
	const result = await runSsh(
		target,
		`echo "$HOME"; uname -sm; command -v apt-get >/dev/null || echo no-apt; [ "$(id -u)" = 0 ] || sudo -n true 2>/dev/null || echo no-sudo`,
	);
	if (result.code === 255) {
		const reason = result.stderr.trim().split("\n").at(-1) ?? "";
		if (/permission denied/i.test(reason)) {
			return { error: `${target.destination} did not let this host sign in.`, denied: true };
		}
		return { error: `Could not reach ${target.destination}: ${reason || "ssh failed"}` };
	}
	if (result.code !== 0) return { error: `${target.destination} answered with exit ${result.code}: ${result.stderr.trim()}` };
	const [home = "", system = "", ...problems] = result.stdout.trim().split("\n");
	if (!/^Linux (x86_64|aarch64|arm64)$/.test(system)) return { error: `Imp needs Linux on x86_64 or arm64, not ${system}.` };
	if (problems.includes("no-apt")) return { error: "Imp sets up Debian or Ubuntu computers; this one has no apt-get." };
	if (problems.includes("no-sudo")) return { error: `${target.destination} has no passwordless sudo. Run the setup command on the computer.` };
	return { home };
}

// Tunnels are child processes of the host, so close them when the host exits.
const tunnels = new Set<ChildProcess>();
process.once("exit", () => {
	for (const child of tunnels) child.kill();
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => process.exit(128 + (signal === "SIGINT" ? 2 : 15)));
}

export function sshProvider(options: SshProviderOptions): MachineProvider {
	const target = sshTarget(options);
	const { destination, home } = target;
	const sshOptions = target.args;
	const runtimeDir = `${home}/.imp`;
	const ssh = (command: string, input?: string | Buffer) => runSsh(target, command, input);
	async function sshOk(what: string, command: string, input?: string | Buffer): Promise<string> {
		const result = await ssh(command, input);
		if (result.code !== 0) {
			const output = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-30).join("\n");
			throw new Error(`${what} on ${destination} failed (exit ${result.code}):\n${output}`);
		}
		return result.stdout;
	}

	/** A local port that forwards to `remotePort` on the machine's loopback, for as long as `child` runs. */
	async function openTunnel(remotePort: number): Promise<Tunnel> {
		const local = await freePort();
		const child = spawn(
			"ssh",
			[...sshOptions, "-N", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${local}:127.0.0.1:${remotePort}`, destination],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		tunnels.add(child);
		let stderr = "";
		child.stderr!.on("data", (chunk) => (stderr += chunk));
		child.on("exit", () => tunnels.delete(child));
		for (let i = 0; i < 200; i++) {
			if (child.exitCode !== null) break;
			if (await accepts(local)) return { port: local, child };
			await sleep(100);
		}
		child.kill();
		throw new Error(`Could not open an SSH tunnel to port ${remotePort} on ${destination}: ${stderr.trim()}`);
	}

	let files: Promise<Runtime> | undefined;
	const setups = new Map<string, ReturnType<typeof setupScript>>();
	const machines = new Map<string, Machine & { close(): void }>();

	/** Stops any agentd and its daemons, installs this runtime, and starts agentd on the machine's loopback. */
	async function startAgentd(token: string, arch: "x64" | "arm64"): Promise<void> {
		const { files: list, digest } = await (files ??= runtime({ platform: "linux", arch }));
		const staging = await mkdtemp(join(tmpdir(), "imp-runtime-"));
		try {
			for (const file of list) {
				const path = join(staging, file.path);
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, file.data);
				if (file.executable) await chmod(path, 0o755);
			}
			const { stdout: tar } = await promisify(execFile)("tar", ["-C", staging, "-cf", "-", "."], {
				encoding: "buffer",
				maxBuffer: 512 * 1024 * 1024,
			});
			await sshOk(
				"Installing the machine runtime",
				`pkill -f '${runtimePattern(runtimeDir)}' || true; rm -rf '${runtimeDir}' && mkdir -p '${runtimeDir}' && tar -xf - -C '${runtimeDir}'`,
				tar,
			);
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
		const env = { ...agentdEnv({ token, digest, runtimeDir, home, host: "127.0.0.1" }), HOME: home };
		// The token goes in on stdin, so it never shows in the machine's process list.
		const start = [
			"set -e",
			`mkdir -p '${home}/workspace'`,
			...Object.entries(env).map(([name, value]) => `export ${name}=${quote(value)}`),
			`cd '${home}'`,
			`setsid -f /usr/local/bin/node '${runtimeDir}/agentd.mjs' >> '${runtimeDir}/agentd.log' 2>&1 < /dev/null`,
		].join("\n");
		await sshOk("Starting agentd", "sh -s", start);
	}

	return {
		name: "ssh",
		workspace: () => `${home}/workspace`,

		async prepareImage(image: ImageSpec) {
			const setup = setupScript(image.setup);
			setups.set(setup.digest, setup);
			return setup.digest;
		},

		async ensure(spec: MachineSpec) {
			const setup = setups.get(spec.image);
			if (!setup) throw new Error(`prepareImage did not prepare ${spec.image}`);
			const [remoteHome, machine, marker] = (
				await sshOk("Reaching the machine", `echo "$HOME"; uname -m; cat ${SETUP_MARKER} 2>/dev/null || true`)
			)
				.trim()
				.split("\n");
			if (remoteHome !== home) throw new Error(`The machine's home is ${remoteHome}, not ${home}; set its home directory`);
			const arch = machine === "x86_64" ? "x64" : machine === "aarch64" || machine === "arm64" ? "arm64" : undefined;
			if (!arch) throw new Error(`Imp machines need an x86_64 or arm64 CPU, not ${machine}`);
			if (marker !== setup.digest) {
				await sshOk(
					"The machine setup (it needs root or passwordless sudo)",
					`if [ "$(id -u)" = 0 ]; then bash -s; else sudo -n bash -s; fi`,
					setup.script,
				);
			}

			let current = machines.get(spec.key);
			if (!current) {
				const token = agentdToken(options.secret, `ssh:${destination}:${spec.key}`);
				const open = new Map<number, Promise<Tunnel>>();
				/** The tunnel to `remotePort`, opened again when its `ssh` exited. */
				const tunnel = async (remotePort: number) => {
					const existing = await open.get(remotePort)?.catch(() => undefined);
					if (existing && existing.child.exitCode === null && existing.child.signalCode === null) return existing;
					const next = openTunnel(remotePort);
					open.set(remotePort, next);
					return next;
				};
				let pending: Promise<string> | undefined;
				/** agentd's base URL, after making sure the tunnel is up and agentd answers with this token and runtime. */
				const ready = () =>
					(pending ??= (async () => {
						const expected = healthFor(token, (await (files ??= runtime({ platform: "linux", arch }))).digest);
						let { port: local } = await tunnel(AGENTD_PORT);
						if (await healthy(local, expected)) return `http://127.0.0.1:${local}`;
						await startAgentd(token, arch);
						for (let i = 0; i < 100; i++) {
							// A tunnel opened while nothing listened may have given up; reopen it if so.
							local = (await tunnel(AGENTD_PORT)).port;
							if (await healthy(local, expected)) return `http://127.0.0.1:${local}`;
							await sleep(100);
						}
						const log = await ssh(`tail -n 50 '${runtimeDir}/agentd.log'`);
						throw new Error(`agentd did not start on ${destination}: ${log.stdout}`);
					})().finally(() => {
						pending = undefined;
					}));
				const endpoints = async () => agentdEndpoints({ url: await ready(), headers: {} }, token);
				current = {
					key: spec.key,
					daemonCommand: async () => (await endpoints()).daemonCommand,
					appSocket: async () => (await endpoints()).appSocket,
					screen: async () => (await endpoints()).screen,
					egress: async () => ({ socket: (await endpoints()).egress, env: egressEnv(home) }),
					expose: async (remotePort) => ({ url: `http://127.0.0.1:${(await tunnel(remotePort)).port}`, headers: {} }),
					keepAlive: async () => {},
					suspend: async () => {},
					close() {
						for (const t of open.values()) void t.then((x) => x.child.kill()).catch(() => {});
						open.clear();
					},
				};
				machines.set(spec.key, current);
			}
			await current.appSocket();
			return current;
		},

		async destroy(key: string) {
			machines.get(key)?.close();
			machines.delete(key);
			await sshOk("Removing the machine runtime", `pkill -f '${runtimePattern(runtimeDir)}' || true; rm -rf '${runtimeDir}'`);
		},

		close() {
			for (const machine of machines.values()) machine.close();
			machines.clear();
		},
	};
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function healthy(port: number, expected: string): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) });
		return (await response.text()) === expected;
	} catch {
		return false;
	}
}

function accepts(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(port, "127.0.0.1");
		socket.once("connect", () => (socket.destroy(), resolve(true)));
		socket.once("error", () => resolve(false));
	});
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

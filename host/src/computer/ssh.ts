// The SSH adapter: the agent's computer is one you bring, such as a home lab box, a VM on this computer (Lima,
// Multipass, OrbStack, WSL), or a cloud VM you rent. The host reaches it with the system `ssh`, as a user with
// passwordless sudo (or root). Settings reach it over Tailscale SSH (see tailnet.ts), which authenticates both ends
// with their tailnet identities; the adapter itself only needs `ssh` to get in. Over SSH the host runs the setup when
// the machine has not run this version, keeps the runtime in ~/.imp, and starts agentd on the machine's loopback. It
// reaches agentd and every exposed port through SSH tunnels it opens itself (ssh-tunnels.ts), so nothing on
// the machine listens on the network. Tailscale (or Tailscale SSH) is one way to reach it.
//
// The computer is yours: it never suspends, `keepAlive()` and `suspend()` do nothing, and `destroy()` removes only
// what the host put in ~/.imp.
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  ImageSpec,
  Machine,
  MachineProvider,
  MachineSpec,
} from "../machine/machine.ts";
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
  writeRuntime,
} from "./runtime.ts";
import { machineTunnels } from "./ssh-tunnels.ts";
import { healthy } from "../kernel/ports.ts";

export type SshTargetOptions = {
  /** `user@host` or `user@host:port`. The host may be a ~/.ssh/config alias. */
  readonly target: string;
  readonly identityFile?: string | undefined;
  /** The host keys to trust, under `hostKeyAlias`; without it, ~/.ssh/known_hosts. */
  readonly knownHostsFile?: string;
  readonly hostKeyAlias?: string;
  /** How `ssh` reaches the machine, such as `tailscale nc %h %p`. */
  readonly proxyCommand?: string;
  /** The user's home directory on the machine. Default: /root for root, else /home/<user>. */
  readonly home?: string | undefined;
};

export type SshProviderOptions = {
  /** Signs per-machine tokens; keep it stable across host restarts. */
  readonly secret: string;
} & SshTargetOptions;

/** `user@host[:port]`, split. */
export function parseSshTarget(
  target: string
):
  | { user?: string | undefined; host: string; port?: number | undefined }
  | undefined {
  const match = /^(?:([^@\s]+)@)?([^@:\s]+)(?::(\d{1,5}))?$/.exec(target);
  const [, user, host, port] = match ?? [];

  if (host === undefined) {
    return undefined;
  }

  return { user, host, port: port ? Number(port) : undefined };
}

/** Where a user's home is on a Linux machine, when the user is named. */
function defaultHome(user: string | undefined): string {
  if (user === "root") {
    return "/root";
  }

  return user ? `/home/${user}` : "";
}

/** How to reach the target with `ssh`: its destination, the options before it, and the user's home there. */
function sshTarget(options: SshTargetOptions) {
  const parsed = parseSshTarget(options.target);

  if (!parsed) {
    throw new Error(
      `The SSH target must look like user@host or user@host:port, not ${options.target}`
    );
  }

  const { user, host, port } = parsed;
  const home = options.home ?? defaultHome(user);

  if (!home) {
    throw new Error(
      "Name the SSH user (user@host) or the machine's home directory"
    );
  }

  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    ...(port ? ["-p", String(port)] : []),
    ...(options.identityFile
      ? ["-i", options.identityFile, "-o", "IdentitiesOnly=yes"]
      : []),
    ...(options.knownHostsFile
      ? [
          "-o",
          `UserKnownHostsFile=${options.knownHostsFile}`,
          "-o",
          "GlobalKnownHostsFile=none",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          `HostKeyAlias=${options.hostKeyAlias ?? host}`,
        ]
      : []),
    ...(options.proxyCommand
      ? ["-o", `ProxyCommand=${options.proxyCommand}`]
      : []),
  ];

  return { destination: user ? `${user}@${host}` : host, args, home };
}

type SshTarget = ReturnType<typeof sshTarget>;

/** Runs `command` with the login user's shell on the machine; `input` is its stdin. */
async function runSsh(
  target: { destination: string; args: string[] },
  command: string,
  input?: string | Buffer
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      [...target.args, "-T", target.destination, command],
      { stdio: ["pipe", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

/** Signs in to the target and checks it can be a machine: its home directory, or why it cannot. */
export async function probeSsh(
  options: SshTargetOptions
): Promise<{ home: string } | { error: string; denied?: true }> {
  const target = sshTarget({ ...options, home: options.home ?? "/" });

  const result = await runSsh(
    target,
    `echo "$HOME"; uname -sm; command -v apt-get >/dev/null || echo no-apt; [ "$(id -u)" = 0 ] || sudo -n true 2>/dev/null || echo no-sudo`
  );

  if (result.code === 255) {
    const reason = result.stderr.trim().split("\n").at(-1) ?? "";

    if (/permission denied/i.test(reason)) {
      return {
        error: `${target.destination} did not let this host sign in.`,
        denied: true,
      };
    }

    return {
      error: `Could not reach ${target.destination}: ${reason || "ssh failed"}`,
    };
  }

  if (result.code !== 0) {
    return {
      error: `${target.destination} answered with exit ${result.code}: ${result.stderr.trim()}`,
    };
  }

  const [home = "", system = "", ...problems] = result.stdout
    .trim()
    .split("\n");

  if (!/^Linux (x86_64|aarch64|arm64)$/.test(system)) {
    return { error: `Imp needs Linux on x86_64 or arm64, not ${system}.` };
  }

  if (problems.includes("no-apt")) {
    return {
      error: "Imp sets up Debian or Ubuntu computers; this one has no apt-get.",
    };
  }

  if (problems.includes("no-sudo")) {
    return {
      error: `${target.destination} has no passwordless sudo. Run the setup command on the computer.`,
    };
  }

  return { home };
}

/** Commands on the target: `run` answers however the command ended, and `ok` throws unless it exited with 0. */
function remoteShell(target: SshTarget) {
  const run = async (command: string, input?: string | Buffer) =>
    await runSsh(target, command, input);

  return {
    run,
    /** The command's stdout; throws that `what` failed, with the end of its output, unless it exited with 0. */
    async ok(
      what: string,
      command: string,
      input?: string | Buffer
    ): Promise<string> {
      const result = await run(command, input);

      if (result.code !== 0) {
        const output = `${result.stdout}\n${result.stderr}`
          .trim()
          .split("\n")
          .slice(-30)
          .join("\n");

        throw new Error(
          `${what} on ${target.destination} failed (exit ${result.code}):\n${output}`
        );
      }

      return result.stdout;
    },
  };
}

type Arch = "x64" | "arm64";

/** The computer as its provider reaches it. */
type Remote = {
  readonly target: SshTarget;
  /** Where the host keeps the runtime on the machine. */
  readonly runtimeDir: string;
  readonly shell: ReturnType<typeof remoteShell>;
  /** The runtime's files for the computer's CPU, read once per provider. */
  readonly runtime: (arch: Arch) => Promise<Runtime>;
};

/** One machine's agentd: the token it is started with, and the CPU its runtime is for. */
type AgentdSpec = {
  readonly token: string;
  readonly arch: Arch;
};

type SshMachine = Machine & { readonly close: () => void };

export function sshProvider(options: SshProviderOptions): MachineProvider {
  const target = sshTarget(options);
  const { destination, home } = target;
  const runtimeDir = `${home}/.imp`;
  const shell = remoteShell(target);
  let files: Promise<Runtime> | undefined;

  const remote: Remote = {
    target,
    runtimeDir,
    shell,
    runtime: async (arch) =>
      await (files ??= runtime({ platform: "linux", arch })),
  };

  const setups = new Map<string, ReturnType<typeof setupScript>>();
  const machines = new Map<string, SshMachine>();

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

      if (!setup) {
        throw new Error(`prepareImage did not prepare ${spec.image}`);
      }

      const arch = await setUp(remote, setup);
      let current = machines.get(spec.key);

      if (!current) {
        const token = agentdToken(
          options.secret,
          `ssh:${destination}:${spec.key}`
        );

        current = sshMachine(remote, spec.key, { token, arch });
        machines.set(spec.key, current);
      }

      await current.appSocket();

      return current;
    },

    async destroy(key: string) {
      machines.get(key)?.close();
      machines.delete(key);
      await shell.ok(
        "Removing the machine runtime",
        `pkill -f '${runtimePattern(runtimeDir)}' || true; rm -rf '${runtimeDir}'`
      );
    },

    close() {
      for (const machine of machines.values()) {
        machine.close();
      }

      machines.clear();
    },
  };
}

/** The runtime's name for the CPU `uname -m` printed, when the runtime has a build for it. */
function archOf(machine: string | undefined): Arch | undefined {
  if (machine === "x86_64") {
    return "x64";
  }

  return machine === "aarch64" || machine === "arm64" ? "arm64" : undefined;
}

/**
 * Signs in to the computer, checks that its home is the one the provider was given and that the runtime has a build
 * for its CPU, and runs the setup when the computer has not run this version. Answers the CPU.
 */
async function setUp(
  remote: Remote,
  setup: ReturnType<typeof setupScript>
): Promise<Arch> {
  const { home } = remote.target;

  const [remoteHome, machine, marker] = (
    await remote.shell.ok(
      "Reaching the machine",
      `echo "$HOME"; uname -m; cat ${SETUP_MARKER} 2>/dev/null || true`
    )
  )
    .trim()
    .split("\n");

  if (remoteHome !== home) {
    throw new Error(
      `The machine's home is ${remoteHome}, not ${home}; set its home directory`
    );
  }

  const arch = archOf(machine);

  if (!arch) {
    throw new Error(`Imp machines need an x86_64 or arm64 CPU, not ${machine}`);
  }

  if (marker !== setup.digest) {
    await remote.shell.ok(
      "The machine setup (it needs root or passwordless sudo)",
      `if [ "$(id -u)" = 0 ]; then bash -s; else sudo -n bash -s; fi`,
      setup.script
    );
  }

  return arch;
}

/** The machine `key` on the computer: its endpoints go through tunnels, opened and checked when first asked for. */
function sshMachine(
  remote: Remote,
  key: string,
  agentd: AgentdSpec
): SshMachine {
  const tunnels = machineTunnels(remote.target);
  let pending: Promise<string> | undefined;

  /** agentd's base URL, once it answers. Calls made while one check runs share it. */
  const ready = async () =>
    await (pending ??= reachAgentd(remote, agentd, tunnels).finally(() => {
      pending = undefined;
    }));

  const endpoints = async () =>
    agentdEndpoints({ url: await ready(), headers: {} }, agentd.token);

  return {
    key,
    daemonCommand: async () => (await endpoints()).daemonCommand,
    appSocket: async () => (await endpoints()).appSocket,
    screen: async () => (await endpoints()).screen,
    chrome: async () => (await endpoints()).chrome,
    egress: async () => ({
      socket: (await endpoints()).egress,
      env: egressEnv(remote.target.home),
    }),
    expose: async (remotePort) => ({
      url: `http://127.0.0.1:${(await tunnels.to(remotePort)).port}`,
      headers: {},
    }),
    // The computer is yours: the host neither suspends it nor keeps it from suspending.
    keepAlive: async () => {
      // Nothing to postpone.
    },
    suspend: async () => {
      // Nothing to suspend.
    },
    close() {
      tunnels.close();
    },
  };
}

/** agentd's base URL, after making sure the tunnel is up and agentd answers with this token and runtime. */
async function reachAgentd(
  remote: Remote,
  agentd: AgentdSpec,
  tunnels: ReturnType<typeof machineTunnels>
): Promise<string> {
  const expected = healthFor(
    agentd.token,
    (await remote.runtime(agentd.arch)).digest
  );

  /** agentd's base URL through its tunnel, when the agentd this host would start answers there. */
  const answering = async () => {
    const { port } = await tunnels.to(AGENTD_PORT);
    const up = await healthy(port, expected, AbortSignal.timeout(5000));

    return up ? `http://127.0.0.1:${port}` : undefined;
  };

  const running = await answering();

  if (running) {
    return running;
  }

  await startAgentd(remote, agentd);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    // A tunnel opened while nothing listened may have given up; `answering` reopens it if so.
    // oxlint-disable-next-line no-await-in-loop -- a poll: each try follows the one that found agentd not up yet.
    const started = await answering();

    if (started) {
      return started;
    }

    // oxlint-disable-next-line no-await-in-loop -- the pause between two tries of the poll.
    await sleep(100);
  }

  const log = await remote.shell.run(
    `tail -n 50 '${remote.runtimeDir}/agentd.log'`
  );

  throw new Error(
    `agentd did not start on ${remote.target.destination}: ${log.stdout}`
  );
}

/** Stops any agentd and its daemons, installs this runtime, and starts agentd on the machine's loopback. */
async function startAgentd(remote: Remote, agentd: AgentdSpec): Promise<void> {
  const { runtimeDir, shell } = remote;
  const { home } = remote.target;
  const { token } = agentd;
  const { files: list, digest } = await remote.runtime(agentd.arch);
  const staging = await mkdtemp(path.join(tmpdir(), "imp-runtime-"));

  try {
    await writeRuntime(list, staging);

    const tar = await packed(staging);

    await shell.ok(
      "Installing the machine runtime",
      `pkill -f '${runtimePattern(runtimeDir)}' || true; rm -rf '${runtimeDir}' && mkdir -p '${runtimeDir}' && tar -xf - -C '${runtimeDir}'`,
      tar
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  const env = {
    ...agentdEnv({ token, digest, runtimeDir, home, host: "127.0.0.1" }),
    HOME: home,
  };

  // The token goes in on stdin, so it never shows in the machine's process list.
  const start = [
    "set -e",
    `mkdir -p '${home}/workspace'`,
    ...Object.entries(env).map(
      ([name, value]) => `export ${name}=${quote(value)}`
    ),
    `cd '${home}'`,
    `setsid -f /usr/local/bin/node '${runtimeDir}/agentd.mjs' >> '${runtimeDir}/agentd.log' 2>&1 < /dev/null`,
  ].join("\n");

  await shell.ok("Starting agentd", "sh -s", start);
}

/** Everything under `dir` on this computer, as one tar archive. */
async function packed(dir: string): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    execFile(
      "tar",
      ["-C", dir, "-cf", "-", "."],
      { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          // Node's own description of the failure, which names the command and carries what it printed.
          reject(new Error(error.message, { cause: error }));
        } else {
          resolve(stdout);
        }
      }
    );
  });
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

// The container adapter: the agent's computer is a container on the machine the host runs on, through Docker (Docker
// Engine, Docker Desktop or OrbStack) or Podman. It needs no other computer and no account anywhere, and like the
// other computers it keeps the agent's commands away from the host: the container sees none of the host's files.
//
// One long-lived container per host and machine key, from Debian, with the agent's home (`imp`, passwordless sudo
// inside the container) on a named volume. The host runs the setup in it when it has not run this version, as the SSH
// adapter does, so a new setup upgrades the container in place. agentd's port is published on the host's loopback
// only, where its token guards it; an exposed port goes through `<cli> exec`, so nothing else is published.
//
// The container is on the host's own machine: it never suspends on its own, `suspend()` stops it, and the next
// `ensure()` starts it again.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  ImageSpec,
  Machine,
  MachineProvider,
  MachineSize,
  MachineSpec,
} from "../machine/machine.ts";
import {
  AGENTD_PORT,
  agentdEndpoints,
  agentdEnv,
  agentdToken,
  egressEnv,
  healthFor,
  healthy,
  packedRuntime,
  runtime,
  runtimePattern,
  SETUP_MARKER,
  setupScript,
  type Runtime,
} from "./runtime.ts";
import { freePort, killOnExit } from "../processes/processes.ts";

const BASE_IMAGE = "debian:bookworm";
const USER = "imp";
const HOME = `/home/${USER}`;
const RUNTIME_DIR = `${HOME}/.imp`;

/**
 * Where a container CLI may be. A host started by launchd sees only the system's PATH, so the places Docker Desktop,
 * OrbStack and Homebrew put theirs are named too.
 */
const CANDIDATES = [
  "docker",
  "podman",
  "/usr/local/bin/docker",
  "/opt/homebrew/bin/docker",
  path.join(homedir(), ".orbstack", "bin", "docker"),
  "/Applications/Docker.app/Contents/Resources/bin/docker",
  "/opt/homebrew/bin/podman",
  "/usr/local/bin/podman",
];

/** A container CLI whose engine answers: the command to run, and its name for the person. */
export type ContainerCli = { readonly command: string; readonly name: string };

export type ContainerRuntime =
  | { readonly ok: true; readonly cli: ContainerCli }
  | { readonly ok: false; readonly problem: string };

type Ran = { code: number | null; stdout: string; stderr: string };

/** Runs a program to its end; `input` is its stdin. A program that cannot start ends with code null. */
async function run(
  command: string,
  args: readonly string[],
  input?: string | Buffer
): Promise<Ran> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });

    killOnExit(child);
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      resolve({ code: null, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {
      // A program that exits before reading its input: its exit says how it went.
    });
    child.stdin.end(input);
  });
}

const nameOf = (command: string) =>
  path.basename(command) === "podman" ? "Podman" : "Docker";

/** Why the engine behind an installed CLI does not answer, for Settings. */
function notAnswering(name: string, stderr: string) {
  if (/permission denied/i.test(stderr)) {
    return `${name} is installed, but this host's user may not use it. On Linux, add the user to the docker group (sudo usermod -aG docker $USER) and restart Imp.`;
  }

  return `${name} is installed but not running. Start it.`;
}

/** The first container CLI on this machine whose engine answers, or why there is none. */
export async function findContainerRuntime(): Promise<ContainerRuntime> {
  const found = CANDIDATES.filter(
    (command) => !path.isAbsolute(command) || existsSync(command)
  );

  // `info` asks the engine, and fails when it does not answer, in Docker and in Podman alike.
  const answers = await Promise.all(
    found.map(async (command) => await run(command, ["info"]))
  );

  const index = answers.findIndex((answer) => answer.code === 0);

  const command = found[index];

  if (command !== undefined) {
    return { ok: true, cli: { command, name: nameOf(command) } };
  }

  // A CLI that ran but whose engine did not answer says more than one that is not installed.
  const installed = answers.findIndex((answer) => answer.code !== null);
  const failed = found[installed];

  return {
    ok: false,
    problem:
      failed === undefined
        ? "Install Docker, OrbStack or Podman on this machine."
        : notAnswering(nameOf(failed), answers[installed]?.stderr ?? ""),
  };
}

/** The container's name: one per host and machine key, so two hosts on one machine never share a container. */
const containerName = (secret: string, key: string) =>
  `imp-${createHash("sha256").update(`${secret}:${key}`).digest("hex").slice(0, 12)}`;

/** Runs as root before the setup: the agent's user, with its home on the volume and sudo, as on any computer. */
const PRELUDE = `set -e
command -v sudo >/dev/null || { apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends sudo; }
id ${USER} >/dev/null 2>&1 || useradd -M -d ${HOME} -s /bin/bash ${USER}
chown ${USER}:${USER} ${HOME}
echo '${USER} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/${USER}
`;

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** What the provider was told for an image: the setup to run, and the container's share of this machine. */
type Prepared = {
  readonly setup: ReturnType<typeof setupScript>;
  readonly size: MachineSize;
};

/** The CLI's commands: `run` answers however one ended, `ok` throws unless it exited with 0. */
function engineShell(cli: ContainerCli) {
  const runIt = async (args: readonly string[], input?: string | Buffer) =>
    await run(cli.command, args, input);

  return {
    cli,
    run: runIt,
    /** The command's stdout; throws that `what` failed, with the end of its output, unless it exited with 0. */
    async ok(what: string, args: readonly string[], input?: string | Buffer) {
      const ran = await runIt(args, input);

      if (ran.code !== 0) {
        const output = `${ran.stdout}\n${ran.stderr}`
          .trim()
          .split("\n")
          .slice(-20)
          .join("\n");

        throw new Error(`${what} failed (exit ${ran.code}):\n${output}`);
      }

      return ran.stdout;
    },
  };
}

type Engine = ReturnType<typeof engineShell>;

/** One machine's container, as the provider reaches it. */
type Box = {
  readonly engine: Engine;
  readonly name: string;
  readonly key: string;
  readonly token: string;
  readonly runtime: () => Promise<Runtime>;
};

/** Creates the container, or starts it when it exists and is stopped. Answers agentd's port on this machine. */
async function up(box: Box, size: MachineSize): Promise<number> {
  const { engine, name } = box;
  const { cli } = engine;

  const state = await engine.run([
    "inspect",
    "--format",
    "{{.State.Running}}",
    name,
  ]);

  if (state.code !== 0) {
    await engine.ok(`Creating the ${cli.name} container`, [
      "run",
      "--detach",
      "--name",
      name,
      "--hostname",
      "imp",
      "--init",
      "--label",
      `dev.imp.machine=${box.key}`,
      "--cpus",
      String(size.cpus),
      "--memory",
      `${size.memoryMB}m`,
      // Chrome needs more shared memory than a container's default 64 MB.
      "--shm-size",
      "1g",
      "--publish",
      `127.0.0.1::${AGENTD_PORT}`,
      "--volume",
      `${name}-home:${HOME}`,
      BASE_IMAGE,
      "sleep",
      "infinity",
    ]);
  } else if (state.stdout.trim() !== "true") {
    await engine.ok(`Starting the ${cli.name} container`, ["start", name]);
  }

  // A started container may get another port: it is read every time.
  const published = await engine.ok("Reading the container's port", [
    "port",
    name,
    `${AGENTD_PORT}/tcp`,
  ]);

  const port = /:(\d+)\s*$/m.exec(published)?.[1];

  if (port === undefined) {
    throw new Error(`The container publishes no port for agentd: ${published}`);
  }

  return Number(port);
}

/** Runs the setup in the container when it has not run this version. */
async function setUp(box: Box, setup: Prepared["setup"]) {
  const { engine, name } = box;
  const marker = await engine.run(["exec", name, "cat", SETUP_MARKER]);

  if (marker.stdout.trim() !== setup.digest) {
    await engine.ok(
      "The machine setup",
      ["exec", "--interactive", "--user", "0", name, "bash", "-s"],
      PRELUDE + setup.script
    );
  }
}

/** Installs this runtime and starts agentd in the container, unless one with this token and runtime answers. */
async function agentd(box: Box, port: number): Promise<string> {
  const { files, digest } = await box.runtime();
  const expected = healthFor(box.token, digest);
  const url = `http://127.0.0.1:${port}`;

  if (await healthy(port, expected, AbortSignal.timeout(5000))) {
    return url;
  }

  const exec = ["exec", "--interactive", "--user", USER, box.name];

  await box.engine.ok(
    "Installing the machine runtime",
    [
      ...exec,
      "sh",
      "-c",
      `pkill -f '${runtimePattern(RUNTIME_DIR)}' || true; rm -rf '${RUNTIME_DIR}' && mkdir -p '${RUNTIME_DIR}' && tar -xf - -C '${RUNTIME_DIR}'`,
    ],
    await packedRuntime(files)
  );

  // agentd listens on every address inside the container, where only the published port reaches it.
  const env = {
    ...agentdEnv({
      token: box.token,
      digest,
      runtimeDir: RUNTIME_DIR,
      home: HOME,
    }),
    HOME,
  };

  // The token goes in on stdin, so it shows neither in the host's process list nor in the container's.
  const start = [
    "set -e",
    `mkdir -p '${HOME}/workspace'`,
    ...Object.entries(env).map(
      ([variable, value]) => `export ${variable}=${quote(value)}`
    ),
    `cd '${HOME}'`,
    `setsid -f /usr/local/bin/node '${RUNTIME_DIR}/agentd.mjs' >> '${RUNTIME_DIR}/agentd.log' 2>&1 < /dev/null`,
  ].join("\n");

  await box.engine.ok("Starting agentd", [...exec, "sh", "-s"], start);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a poll: each try follows the one that found agentd not up yet.
    if (await healthy(port, expected, AbortSignal.timeout(1000))) {
      return url;
    }

    // oxlint-disable-next-line no-await-in-loop -- the pause between two tries of the poll.
    await sleep(100);
  }

  const log = await box.engine.run([
    ...exec,
    "tail",
    "-n",
    "30",
    `${RUNTIME_DIR}/agentd.log`,
  ]);

  throw new Error(`agentd did not start in the container: ${log.stdout}`);
}

/** A program run in the container that joins its stdin and stdout to `port` on the container's loopback. */
const RELAY =
  'const s=require("net").connect(Number(process.argv[1]),"127.0.0.1");process.stdin.pipe(s);s.pipe(process.stdout);s.on("error",()=>process.exit(1));s.on("close",()=>process.exit(0))';

/** A port on this machine's loopback whose every connection is a `<cli> exec` relay to `port` in the container. */
async function relay(
  box: Box,
  port: number
): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => {
    const child = spawn(
      box.engine.cli.command,
      ["exec", "--interactive", box.name, "node", "-e", RELAY, String(port)],
      { stdio: ["pipe", "pipe", "ignore"] }
    );

    killOnExit(child);

    const end = () => {
      socket.destroy();
      child.kill();
    };

    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    socket.on("error", end);
    socket.on("close", end);
    child.on("exit", end);
  });

  const local = await freePort();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(local, "127.0.0.1", resolve);
  });

  return { server, port: local };
}

/** The machine in `box`: its endpoints reach agentd through the published port, read again on every use. */
function containerMachine(box: Box, size: MachineSize) {
  const relays = new Map<number, ReturnType<typeof relay>>();
  let pending: Promise<string> | undefined;

  /** agentd's base URL, with the container started and agentd answering. Calls made while one runs share it. */
  const ready = async () =>
    await (pending ??= (async () =>
      await agentd(box, await up(box, size)))().finally(() => {
      pending = undefined;
    }));

  const endpoints = async () =>
    agentdEndpoints({ url: await ready(), headers: {} }, box.token);

  const machine: Machine = {
    key: box.key,
    daemonCommand: async () => (await endpoints()).daemonCommand,
    appSocket: async () => (await endpoints()).appSocket,
    screen: async () => (await endpoints()).screen,
    chrome: async () => (await endpoints()).chrome,
    egress: async () => ({
      socket: (await endpoints()).egress,
      env: egressEnv(HOME),
    }),
    async expose(port) {
      let opened = relays.get(port);

      if (!opened) {
        opened = relay(box, port);
        relays.set(port, opened);
        opened.catch(() => relays.delete(port));
      }

      return { url: `http://127.0.0.1:${(await opened).port}`, headers: {} };
    },
    // It runs on the owner's machine, which bills nothing for it: nothing to postpone.
    keepAlive: async () => {
      // Nothing to postpone.
    },
    async suspend() {
      await box.engine.ok("Stopping the container", ["stop", box.name]);
    },
  };

  return {
    machine,
    ready,
    close() {
      for (const opened of relays.values()) {
        opened
          .then(({ server }) => server.close())
          .catch((cause: unknown) => {
            console.error(`container: ${String(cause)}`);
          });
      }

      relays.clear();
    },
  };
}

export type ContainerProviderOptions = {
  /** Signs per-machine tokens and names the container; keep it stable across host restarts. */
  readonly secret: string;
};

export function containerProvider(
  options: ContainerProviderOptions
): MachineProvider {
  const prepared = new Map<string, Prepared>();
  const machines = new Map<string, ReturnType<typeof containerMachine>>();
  let files: Promise<Runtime> | undefined;

  /** The CLI, found again until one answers. */
  const cli = async () => {
    const found = await findContainerRuntime();

    if (!found.ok) {
      throw new Error(found.problem);
    }

    return found.cli;
  };

  const box = (found: ContainerCli, key: string): Box => ({
    engine: engineShell(found),
    name: containerName(options.secret, key),
    key,
    token: agentdToken(options.secret, `container:${key}`),
    // The container runs the CPU of the machine it is on.
    runtime: async () =>
      await (files ??= runtime({
        platform: "linux",
        arch: process.arch === "arm64" ? "arm64" : "x64",
      })),
  });

  return {
    name: "container",
    workspace: () => `${HOME}/workspace`,

    async prepareImage(image: ImageSpec) {
      const setup = setupScript(image.setup);

      prepared.set(setup.digest, { setup, size: image.size });

      return setup.digest;
    },

    async ensure(spec: MachineSpec) {
      const image = prepared.get(spec.image);

      if (!image) {
        throw new Error(`prepareImage did not prepare ${spec.image}`);
      }

      const at = box(await cli(), spec.key);

      await up(at, image.size);
      await setUp(at, image.setup);

      let current = machines.get(spec.key);

      if (!current) {
        current = containerMachine(at, image.size);
        machines.set(spec.key, current);
      }

      await current.ready();

      return current.machine;
    },

    async destroy(key: string) {
      machines.get(key)?.close();
      machines.delete(key);

      const at = box(await cli(), key);

      await at.engine.ok("Removing the container", ["rm", "--force", at.name]);
      await at.engine.ok("Removing the container's home", [
        "volume",
        "rm",
        "--force",
        `${at.name}-home`,
      ]);
    },

    close() {
      for (const machine of machines.values()) {
        machine.close();
      }

      machines.clear();
    },
  };
}

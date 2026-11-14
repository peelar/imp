// The local adapter: the "machine" is a directory on the host and agentd a child process of the host. It isolates
// nothing, so it is for development and tests only; the E2B adapter is the one to give an agent your accounts with.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  Machine,
  MachineEgress,
  MachineProvider,
  MachineSpec,
} from "./machine.ts";
import {
  agentdEndpoints,
  agentdEnv,
  agentdToken,
  egressEnv,
  healthFor,
  runtime,
  type Runtime,
  writeRuntime,
} from "./machine-runtime.ts";
import { freePort, healthy } from "./ports.ts";

export type LocalProviderOptions = {
  readonly secret: string;
  /** Each machine is a directory under this one. */
  readonly dir: string;
};

/** One machine's agentd, as the host started it. */
type Agentd = {
  readonly child: ChildProcess;
  readonly port: number;
  readonly egressPort: number;
  readonly token: string;
};

export function localProvider(options: LocalProviderOptions): MachineProvider {
  const running = new Map<string, Agentd>();

  // A local machine lives as long as its host: agentd is a child process, so stop it when the host exits.
  process.once("exit", () => {
    for (const { child } of running.values()) {
      child.kill();
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () =>
      process.exit(128 + (signal === "SIGINT" ? 2 : 15))
    );
  }

  let files: Promise<Runtime> | undefined;

  const dirFor = (key: string) =>
    path.join(options.dir, key.replaceAll(/[^a-zA-Z0-9_-]/g, "_"));

  const home = (key: string) => path.join(dirFor(key), "home");

  return {
    name: "local",
    workspace: (key) => path.join(home(key), "workspace"),
    async prepareImage() {
      return "local";
    },

    async ensure(spec: MachineSpec) {
      const token = agentdToken(options.secret, `local:${spec.key}`);

      const { files: list, digest } = await (files ??= runtime({
        platform: process.platform === "darwin" ? "darwin" : "linux",
        arch: process.arch === "arm64" ? "arm64" : "x64",
      }));

      const expected = healthFor(token, digest);
      let current = running.get(spec.key);

      if (
        !current ||
        current.child.exitCode !== null ||
        !(await healthy(current.port, expected))
      ) {
        current?.child.kill();
        const runtimeDir = path.join(dirFor(spec.key), "runtime");

        await writeRuntime(list, runtimeDir);
        await mkdir(path.join(home(spec.key), "workspace"), {
          recursive: true,
        });
        // Every local machine shares the host's loopback, so each takes free ports.
        const [port, egressPort] = await Promise.all([freePort(), freePort()]);

        const child = spawnAgentd({
          runtimeDir,
          home: home(spec.key),
          port,
          egressPort,
          token,
          digest,
        });

        current = { child, port, egressPort, token };
        running.set(spec.key, current);
        await started(port, expected);
      }

      return localMachine(spec.key, {
        port: current.port,
        token,
        egress: egressEnv(home(spec.key), current.egressPort),
      });
    },

    async destroy(key: string) {
      running.get(key)?.child.kill();
      running.delete(key);
      await rm(dirFor(key), { recursive: true, force: true });
    },

    close() {
      for (const { child } of running.values()) {
        child.kill();
      }

      running.clear();
    },
  };
}

/** agentd as a child of the host, run from `runtimeDir` and listening on this computer's loopback only. */
function spawnAgentd(options: {
  readonly runtimeDir: string;
  readonly home: string;
  readonly port: number;
  readonly egressPort: number;
  readonly token: string;
  readonly digest: string;
}): ChildProcess {
  const { runtimeDir, home, port, egressPort, token, digest } = options;

  return spawn(process.execPath, [path.join(runtimeDir, "agentd.mjs")], {
    env: {
      ...process.env,
      ...agentdEnv({
        token,
        digest,
        runtimeDir,
        home,
        host: "127.0.0.1",
        egressPort,
      }),
      AGENTD_PORT: String(port),
      HOME: home,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
}

/** Waits for the agentd just started on `port` to answer as `expected`; throws when it does not within its tries. */
async function started(port: number, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a poll: each try follows the one that found agentd not up yet.
    if (await healthy(port, expected)) {
      return;
    }

    // oxlint-disable-next-line no-await-in-loop -- the pause between two tries of the poll.
    await sleep(50);
  }

  throw new Error("agentd did not start on the local machine");
}

/** How to reach a machine's agentd on this computer, and what its commands need for the egress proxy. */
type LocalAgentd = {
  readonly port: number;
  readonly token: string;
  readonly egress: MachineEgress["env"];
};

function localMachine(key: string, agentd: LocalAgentd): Machine {
  const endpoints = agentdEndpoints(
    { url: `http://127.0.0.1:${agentd.port}`, headers: {} },
    agentd.token
  );

  return {
    key,
    daemonCommand: async () => endpoints.daemonCommand,
    appSocket: async () => endpoints.appSocket,
    screen: async () => endpoints.screen,
    egress: async () => ({ socket: endpoints.egress, env: agentd.egress }),
    expose: async (port) => ({
      url: `http://127.0.0.1:${port}`,
      headers: {},
    }),
    // A local machine runs for as long as its host does: nothing suspends it.
    keepAlive: async () => {
      // Nothing to postpone.
    },
    suspend: async () => {
      // Nothing to suspend.
    },
  };
}

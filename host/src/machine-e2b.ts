// The E2B adapter. A machine is one E2B sandbox, found by its `machineKey` metadata. It pauses itself when idle,
// keeping memory and disk with no expiry, and wakes on the next request to one of its URLs. The setup is baked into
// one template per setup version and size, so a new machine starts set up; an existing machine runs a newer setup in
// place, because its disk is the user's. E2B cannot resize a sandbox, so a machine is found by its key and size: another
// size is another sandbox, and the one of the old size stays paused with its files.
import { setTimeout as sleep } from "node:timers/promises";
import { Sandbox, Template } from "e2b";
import type {
  ImageSpec,
  Machine,
  MachineProvider,
  MachineSpec,
} from "./machine.ts";
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

const HOME = "/home/user";
const RUNTIME_DIR = `${HOME}/.imp`;

export type E2BProviderOptions = {
  /** Signs per-machine tokens; keep it stable across host restarts. */
  readonly secret: string;
  readonly apiKey?: string;
};

export function e2bProvider(options: E2BProviderOptions): MachineProvider {
  const api = options.apiKey === undefined ? {} : { apiKey: options.apiKey };
  let files: Promise<Runtime> | undefined;

  /** Template name -> the setup it was built from (for machines created from an older template) and its size. */
  const prepared = new Map<
    string,
    { setup: ReturnType<typeof setupScript>; size: string }
  >();

  async function find(key: string, size?: string) {
    const metadata: Record<string, string> =
      size === undefined
        ? { machineKey: key }
        : { machineKey: key, machineSize: size };

    const pages = Sandbox.list({
      ...api,
      query: { metadata, state: ["running", "paused"] },
    });

    const items = pages.hasNext ? await pages.nextItems() : [];

    return items[0];
  }

  return {
    name: "e2b",
    workspace: () => `${HOME}/workspace`,

    async prepareImage(image: ImageSpec) {
      const setup = setupScript(image.setup);
      const { cpus, memoryMB } = image.size;
      const size = `${cpus}c-${memoryMB}m`;
      const name = `imp-machine-${setup.digest}-${size}`;

      if (!(await Template.exists(name, api))) {
        const script = Buffer.from(setup.script).toString("base64");

        const template = Template()
          .fromBaseImage()
          .runCmd(`echo ${script} | base64 -d | bash`, { user: "root" });

        await Template.build(template, name, {
          ...api,
          cpuCount: cpus,
          memoryMB,
        });
      }

      prepared.set(name, { setup, size });

      return name;
    },

    async ensure(spec: MachineSpec) {
      const image = prepared.get(spec.image);

      if (!image) {
        throw new Error(`prepareImage did not prepare ${spec.image}`);
      }

      const { setup, size } = image;
      const existing = await find(spec.key, size);

      const sandbox = existing
        ? await Sandbox.connect(existing.sandboxId, {
            ...api,
            timeoutMs: spec.idleSuspendMs,
          })
        : await Sandbox.create(spec.image, {
            ...api,
            metadata: { machineKey: spec.key, machineSize: size },
            timeoutMs: spec.idleSuspendMs,
            lifecycle: { onTimeout: "pause", autoResume: true },
            network: { allowPublicTraffic: false },
          });

      const marker = await sandbox.commands.run(
        `cat ${SETUP_MARKER} 2>/dev/null || true`
      );

      if (marker.stdout.trim() !== setup.digest) {
        await sandbox.files.write("/tmp/imp-setup.sh", setup.script);
        await sandbox.commands.run(
          "bash /tmp/imp-setup.sh && rm /tmp/imp-setup.sh",
          { user: "root", timeoutMs: 30 * 60_000 }
        );
      }

      const token = agentdToken(options.secret, sandbox.sandboxId);
      await startAgentd(
        sandbox,
        token,
        await (files ??= runtime({ platform: "linux", arch: "x64" }))
      );

      return e2bMachine(spec, sandbox, token);
    },

    async destroy(key: string) {
      const existing = await find(key);

      if (existing) {
        await Sandbox.kill(existing.sandboxId, api);
      }
    },

    close() {
      // Nothing to close: this provider holds nothing open between its calls to E2B.
    },
  };
}

function e2bMachine(
  spec: MachineSpec,
  sandbox: Sandbox,
  token: string
): Machine {
  // Sandbox URLs refuse requests without this header (allowPublicTraffic: false).
  const headers: Record<string, string> = sandbox.trafficAccessToken
    ? { "e2b-traffic-access-token": sandbox.trafficAccessToken }
    : {};

  const endpoints = agentdEndpoints(
    { url: `https://${sandbox.getHost(AGENTD_PORT)}`, headers },
    token
  );

  return {
    key: spec.key,
    async daemonCommand() {
      return endpoints.daemonCommand;
    },
    async appSocket() {
      return endpoints.appSocket;
    },
    async screen() {
      return endpoints.screen;
    },
    async egress() {
      return { socket: endpoints.egress, env: egressEnv(HOME) };
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
async function startAgentd(
  sandbox: Sandbox,
  token: string,
  { files, digest }: Runtime
): Promise<void> {
  const expected = healthFor(token, digest);

  const health = async () =>
    await sandbox.commands.run(
      `curl -sf http://127.0.0.1:${AGENTD_PORT}/health || true`
    );

  const answer = (await health()).stdout.trim();

  if (answer === expected) {
    return;
  }

  if (answer !== "") {
    // Another runtime holds the port (an older version, or one started with another token). Everything run from the
    // runtime directory is ours, so stop all of it, pi-env daemons included, and wait for the port to free up.
    await sandbox.commands.run(
      `pkill -f "${runtimePattern(RUNTIME_DIR)}" || true; for i in $(seq 50); do curl -s -o /dev/null http://127.0.0.1:${AGENTD_PORT}/ || exit 0; sleep 0.1; done; exit 1`
    );
  }

  await sandbox.files.write(
    files.map((file) => ({
      path: `${RUNTIME_DIR}/${file.path}`,
      data: toArrayBuffer(file.data),
    }))
  );

  const executables = files
    .filter((file) => file.executable)
    .map((file) => `${RUNTIME_DIR}/${file.path}`);

  await sandbox.commands.run(
    `chmod +x ${executables.join(" ")} && mkdir -p ${HOME}/workspace`
  );
  await sandbox.commands.run(
    `/usr/local/bin/node ${RUNTIME_DIR}/agentd.mjs >> ${RUNTIME_DIR}/agentd.log 2>&1`,
    {
      background: true,
      envs: agentdEnv({ token, digest, runtimeDir: RUNTIME_DIR, home: HOME }),
    }
  );

  for (let attempt = 0; attempt < 50; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a poll: each try follows the one that found agentd not up yet.
    if ((await health()).stdout.trim() === expected) {
      return;
    }

    // oxlint-disable-next-line no-await-in-loop -- the pause between two tries of the poll.
    await sleep(200);
  }

  const log = await sandbox.commands.run(
    `tail -n 50 ${RUNTIME_DIR}/agentd.log || true`
  );

  throw new Error(`agentd did not start: ${log.stdout}`);
}

/** The buffer's bytes in an ArrayBuffer of their own, which is what E2B takes: a Buffer may share its memory. */
const toArrayBuffer = (buffer: Buffer): ArrayBuffer =>
  new Uint8Array(buffer).buffer;

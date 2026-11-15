// The SSH adapter's tunnels (see ssh.ts). A tunnel is an `ssh -N -L` child process of the host that forwards
// a port on this computer's loopback to a port on the machine's loopback, so nothing on the machine listens on the
// network. This module opens them, opens them again when their `ssh` exited, and closes them with the host.
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { killOnExit } from "../kernel/children.ts";
import { accepts, freePort } from "../kernel/ports.ts";

export type Tunnel = {
  readonly port: number;
  readonly child: ChildProcess;
};

/** Where a tunnel goes: `ssh`'s destination and the options before it. */
export type TunnelTarget = {
  readonly destination: string;
  readonly args: readonly string[];
};

/** A local port that forwards to `remotePort` on the machine's loopback, for as long as `child` runs. */
async function openTunnel(
  target: TunnelTarget,
  remotePort: number
): Promise<Tunnel> {
  const local = await freePort();

  const child = spawn(
    "ssh",
    [
      ...target.args,
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      `127.0.0.1:${local}:127.0.0.1:${remotePort}`,
      target.destination,
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );

  // Tunnels are child processes of the host, so they close when the host exits.
  killOnExit(child);
  let stderr = "";

  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf-8");
  });

  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) {
      break;
    }

    // oxlint-disable-next-line no-await-in-loop -- a poll: each try follows the one that found the port still closed.
    if (await accepts(local)) {
      return { port: local, child };
    }

    // oxlint-disable-next-line no-await-in-loop -- the pause between two tries of the poll.
    await sleep(100);
  }

  child.kill();
  throw new Error(
    `Could not open an SSH tunnel to port ${remotePort} on ${target.destination}: ${stderr.trim()}`
  );
}

/** A tunnel that did not open is no tunnel: `openTunnel` stopped its `ssh`, and whoever asked for it heard why. */
const noTunnel = (): undefined => undefined;

/** One machine's tunnels, by the port each reaches on the machine. */
export function machineTunnels(target: TunnelTarget) {
  const open = new Map<number, Promise<Tunnel>>();

  return {
    /** The tunnel to `remotePort`, opened again when its `ssh` exited. */
    async to(remotePort: number): Promise<Tunnel> {
      const existing = await open.get(remotePort)?.catch(noTunnel);

      if (
        existing &&
        existing.child.exitCode === null &&
        existing.child.signalCode === null
      ) {
        return existing;
      }

      const next = openTunnel(target, remotePort);

      open.set(remotePort, next);

      return await next;
    },
    /** Stops every tunnel, the ones still opening as soon as they are open. */
    close() {
      for (const opening of open.values()) {
        void opening.then((tunnel) => tunnel.child.kill()).catch(noTunnel);
      }

      open.clear();
    },
  };
}

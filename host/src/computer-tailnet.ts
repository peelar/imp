// The owner's own computers: the Linux devices on the tailnet, which of them can be the agent's, and how the host
// signs in to one (Tailscale SSH, trusting the host keys Tailscale advertises for the device).
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  COMPUTER_TAG,
  COMPUTER_USER,
  readTailnet,
  type TailnetDevice,
  writeKnownHosts,
} from "./tailnet.ts";

/** A Linux computer on the tailnet, and why it cannot be the agent's yet ("" when it can). */
export type ComputerDevice = {
  id: string;
  name: string;
  problem: string;
};

export type OwnComputers = ReturnType<typeof ownComputers>;

/** A device's name without its tailnet, such as "homelab" for "homelab.tail1234.ts.net". */
const shortName = (dnsName: string) => {
  const [first = dnsName] = dnsName.split(".");

  return first;
};

/** Why a device cannot be the agent's computer yet; "" when it can. */
export function deviceProblem(device: TailnetDevice): string {
  if (!device.tags.includes(COMPUTER_TAG)) {
    return `Not tagged ${COMPUTER_TAG}`;
  }

  if (device.hostKeys.length === 0) {
    return "Tailscale SSH is off";
  }

  if (!device.online) {
    return "Offline";
  }

  return "";
}

/** `sshDir` holds one known_hosts file per device; `tailscale` is the Tailscale CLI. */
export function ownComputers(sshDir: string, tailscale: string) {
  mkdirSync(sshDir, { recursive: true, mode: 0o700 });

  const knownHosts = (device: string) =>
    path.join(
      sshDir,
      `${device.replaceAll(/[^a-zA-Z0-9.-]/g, "_")}.known_hosts`
    );

  let devices: ComputerDevice[] = [];
  let error = "";
  let source = "";

  return {
    /** How `ssh` reaches a device as the agent's user. */
    sshOptions: (device: string, home?: string) => ({
      target: `${COMPUTER_USER}@${device}`,
      home,
      knownHostsFile: knownHosts(device),
      hostKeyAlias: device,
      proxyCommand: `${tailscale} nc %h %p`,
    }),
    /** Reads the tailnet's devices again: the ones that can be the agent's first, then by name. */
    async refresh() {
      try {
        const tailnet = await readTailnet(tailscale);

        ({ source } = tailnet);
        devices = tailnet.devices
          .flatMap((device) =>
            device.os === "linux"
              ? [
                  {
                    id: device.dnsName,
                    name: device.name || shortName(device.dnsName),
                    problem: deviceProblem(device),
                  },
                ]
              : []
          )
          .toSorted(
            (a, b) =>
              Number(a.problem !== "") - Number(b.problem !== "") ||
              a.name.localeCompare(b.name)
          );
        error = "";
      } catch (cause) {
        devices = [];
        error = cause instanceof Error ? cause.message : String(cause);
      }
    },
    /** The devices as last read. */
    devices: () => devices,
    /** Why the tailnet could not be read last time; "" when it could. */
    error: () => error,
    /** How the tailnet policy names this host as an SSH source. */
    source: () => source,
    /** What Settings calls a device. */
    nameOf: (dnsName: string) =>
      devices.find((device) => device.id === dnsName)?.name ??
      shortName(dnsName),
    /** The device as the tailnet has it now, if it is there. */
    find: async (dnsName: string) =>
      (await readTailnet(tailscale)).devices.find(
        (device) => device.dnsName === dnsName
      ),
    /** Trusts the host keys Tailscale advertises for the device now; it may rotate them. */
    trust: async (device: TailnetDevice) => {
      await writeKnownHosts(knownHosts(device.dnsName), device);
    },
  };
}

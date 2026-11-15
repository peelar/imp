// The tailnet the host is on, read from the local `tailscale` CLI. Your own computer is a device on it: Tailscale
// SSH signs the host in with its tailnet identity (no keys of ours) and advertises each device's SSH host keys, which
// the host trusts instead of asking anyone to compare fingerprints. This is what `tailscale ssh` does; the host does it
// with stock `ssh` because it needs its own flags (tunnels), which `tailscale ssh` does not pass through.
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import {
  arr,
  bool,
  compile,
  map,
  nullable,
  num,
  obj,
  opt,
  str,
} from "@earendil-works/pi-schema";

/** The tag a computer advertises to be the agent's. */
export const COMPUTER_TAG = "tag:imp-computer";

/** The user the agent works as on its computer. */
export const COMPUTER_USER = "imp";

export type TailnetDevice = {
  /** The MagicDNS name without the trailing dot, such as "homelab.tail1234.ts.net". */
  readonly dnsName: string;
  readonly name: string;
  readonly ip: string;
  readonly os: string;
  readonly online: boolean;
  readonly tags: readonly string[];
  /** Present when the device runs Tailscale SSH. */
  readonly hostKeys: readonly string[];
};

export type Tailnet = {
  /** How the tailnet policy names this host as an SSH source: its login, such as "adrian@github", or its tag. */
  readonly source: string;
  readonly devices: readonly TailnetDevice[];
};

// What the host reads of `tailscale status --json`. Tailscale says much more, so every object is open. It also leaves
// out what it has nothing to say about, and writes null for an empty list or map, so every field may be absent or null.
const peerStatus = obj(
  {
    DNSName: opt(nullable(str())),
    HostName: opt(nullable(str())),
    OS: opt(nullable(str())),
    Online: opt(nullable(bool())),
    TailscaleIPs: opt(nullable(arr(str()))),
    Tags: opt(nullable(arr(str()))),
    sshHostKeys: opt(nullable(arr(str()))),
    UserID: opt(nullable(num())),
  },
  { open: true }
);

const tailscaleStatus = compile(
  obj(
    {
      BackendState: opt(nullable(str())),
      Self: opt(nullable(peerStatus)),
      Peer: opt(nullable(map(peerStatus))),
      User: opt(
        nullable(map(obj({ LoginName: opt(nullable(str())) }, { open: true })))
      ),
    },
    { open: true }
  )
);

/** The tailnet as the host sees it. Rejects with a plain reason when the host is not on one. */
export async function readTailnet(
  tailscale = process.env.TAILSCALE ?? "tailscale"
): Promise<Tailnet> {
  const status = await readStatus(tailscale);

  if (status.BackendState !== "Running") {
    throw new Error(
      `Tailscale on this host is ${status.BackendState ?? "not running"}.`
    );
  }

  const self = status.Self ?? {};

  const source =
    self.Tags?.[0] ?? status.User?.[String(self.UserID)]?.LoginName ?? "";

  const devices = Object.values(status.Peer ?? {}).map(
    (peer): TailnetDevice => ({
      dnsName: (peer.DNSName ?? "").replace(/\.$/, ""),
      name: peer.HostName ?? "",
      ip:
        peer.TailscaleIPs?.find((ip) => !ip.includes(":")) ??
        peer.TailscaleIPs?.[0] ??
        "",
      os: peer.OS ?? "",
      online: peer.Online === true,
      tags: peer.Tags ?? [],
      hostKeys: peer.sshHostKeys ?? [],
    })
  );

  return {
    source,
    devices: devices.filter((d) => d.dnsName !== "" && d.ip !== ""),
  };
}

/** What `tailscale status --json` says, checked. An answer that is not a status fails like a command that failed. */
async function readStatus(tailscale: string) {
  const status: unknown = JSON.parse(await runStatus(tailscale));
  const checked = tailscaleStatus.validate(status);

  if (!checked.ok) {
    const problems = checked.errors.map(
      (error) => `${error.path || "the status"}: ${error.message}`
    );

    throw new Error(
      `Tailscale did not answer with a status this host can read: ${problems.join("; ")}`
    );
  }

  return checked.value;
}

/** What `tailscale status --json` printed. Rejects with a plain reason when the command is missing or fails. */
async function runStatus(tailscale: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(
      tailscale,
      ["status", "--json"],
      { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);

          return;
        }

        if (error.code === "ENOENT") {
          reject(
            new Error(
              "This host is not on Tailscale: the tailscale command is missing.",
              { cause: error }
            )
          );

          return;
        }

        // What the command said for itself, or, when it said nothing, how Node describes the failure.
        const said = stderr.trim() || `${error.name}: ${error.message}`;

        reject(
          new Error(`Tailscale did not answer: ${said}`, { cause: error })
        );
      }
    );
  });
}

/** Writes the device's advertised SSH host keys as a known_hosts file, under its DNS name. */
export async function writeKnownHosts(
  file: string,
  device: TailnetDevice
): Promise<void> {
  const lines = device.hostKeys
    .map((key) => key.trim())
    .filter((key) => key !== "" && !/[\r\n]/.test(key));

  await writeFile(
    file,
    lines.map((key) => `${device.dnsName} ${key}\n`).join(""),
    { mode: 0o600 }
  );
}

/**
 * A prompt for the person's coding agent that makes a Linux computer the imp's: the tailnet policy first, because
 * Tailscale refuses a tag no policy owns, then Tailscale with SSH and the tag, and the user the agent works as. People
 * see only that it is a prompt; the commands and the policy are for the agent that runs them.
 */
export function setupPrompt(source: string): string {
  const policy = JSON.stringify(
    {
      tagOwners: { [COMPUTER_TAG]: ["autogroup:admin"] },
      ssh: [
        {
          action: "accept",
          src: [source],
          dst: [COMPUTER_TAG],
          users: [COMPUTER_USER],
        },
      ],
    },
    null,
    2
  );

  const command = [
    "curl -fsSL https://tailscale.com/install.sh | sh",
    `sudo tailscale up --ssh --advertise-tags=${COMPUTER_TAG}`,
    `(id ${COMPUTER_USER} >/dev/null 2>&1 || sudo useradd -m -s /bin/bash ${COMPUTER_USER})`,
    `echo '${COMPUTER_USER} ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/${COMPUTER_USER} >/dev/null`,
  ].join(" && ");

  return `Set up this Linux computer so my Imp can work on it over Tailscale SSH.

1. Merge these entries into my tailnet policy file (https://login.tailscale.com/admin/acls/file). Keep everything already there. If you cannot edit the policy yourself, tell me exactly what to paste and where, and wait until I have.

${policy}

2. Run this once on this computer. If Tailscale asks me to sign in, show me the link.

${command}

3. Check that \`tailscale status\` lists this computer with ${COMPUTER_TAG}, and that \`sudo -u ${COMPUTER_USER} sudo -n true\` succeeds. Then tell me to go back to Imp and choose this computer.
`;
}

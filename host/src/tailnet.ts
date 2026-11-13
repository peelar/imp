// The tailnet the host is on, read from the local `tailscale` CLI. Your own computer is a device on it: Tailscale
// SSH signs the host in with its tailnet identity (no keys of ours) and advertises each device's SSH host keys, which
// the host trusts instead of asking anyone to compare fingerprints. This is what `tailscale ssh` does; the host does it
// with stock `ssh` because it needs its own flags (tunnels), which `tailscale ssh` does not pass through.
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";

/** The tag a computer advertises to be the agent's. */
export const COMPUTER_TAG = "tag:imp-computer";
/** The user the agent works as on its computer. */
export const COMPUTER_USER = "imp";

export interface TailnetDevice {
	/** The MagicDNS name without the trailing dot, such as "homelab.tail1234.ts.net". */
	readonly dnsName: string;
	readonly name: string;
	readonly ip: string;
	readonly os: string;
	readonly online: boolean;
	readonly tags: readonly string[];
	/** Present when the device runs Tailscale SSH. */
	readonly hostKeys: readonly string[];
}

export interface Tailnet {
	/** How the tailnet policy names this host as an SSH source: its login, such as "adrian@github", or its tag. */
	readonly source: string;
	readonly devices: readonly TailnetDevice[];
}

interface PeerStatus {
	DNSName?: string;
	HostName?: string;
	OS?: string;
	Online?: boolean;
	TailscaleIPs?: string[];
	Tags?: string[];
	sshHostKeys?: string[];
	UserID?: number;
}

/** The tailnet as the host sees it. Rejects with a plain reason when the host is not on one. */
export async function readTailnet(tailscale = process.env.TAILSCALE ?? "tailscale"): Promise<Tailnet> {
	let stdout: string;
	try {
		({ stdout } = await promisify(execFile)(tailscale, ["status", "--json"], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw new Error("This host is not on Tailscale: the tailscale command is missing.");
		throw new Error(`Tailscale did not answer: ${(error as { stderr?: string }).stderr?.trim() || String(error)}`);
	}
	const status = JSON.parse(stdout) as {
		BackendState?: string;
		Self?: PeerStatus;
		Peer?: Record<string, PeerStatus>;
		User?: Record<string, { LoginName?: string }>;
	};
	if (status.BackendState !== "Running") throw new Error(`Tailscale on this host is ${status.BackendState ?? "not running"}.`);
	const self = status.Self ?? {};
	const source = self.Tags?.[0] ?? status.User?.[String(self.UserID)]?.LoginName ?? "";
	const devices = Object.values(status.Peer ?? {}).map(
		(peer): TailnetDevice => ({
			dnsName: (peer.DNSName ?? "").replace(/\.$/, ""),
			name: peer.HostName ?? "",
			ip: peer.TailscaleIPs?.find((ip) => !ip.includes(":")) ?? peer.TailscaleIPs?.[0] ?? "",
			os: peer.OS ?? "",
			online: peer.Online === true,
			tags: peer.Tags ?? [],
			hostKeys: peer.sshHostKeys ?? [],
		}),
	);
	return { source, devices: devices.filter((d) => d.dnsName !== "" && d.ip !== "") };
}

/** Writes the device's advertised SSH host keys as a known_hosts file, under its DNS name. */
export async function writeKnownHosts(file: string, device: TailnetDevice): Promise<void> {
	const lines = device.hostKeys.map((key) => key.trim()).filter((key) => key !== "" && !/[\r\n]/.test(key));
	await writeFile(file, lines.map((key) => `${device.dnsName} ${key}\n`).join(""), { mode: 0o600 });
}

/** What to run once on the computer: Tailscale with SSH and the computer tag, and the user the agent works as. */
export function computerCommand(): string {
	return [
		"curl -fsSL https://tailscale.com/install.sh | sh",
		`sudo tailscale up --ssh --advertise-tags=${COMPUTER_TAG}`,
		`(id ${COMPUTER_USER} >/dev/null 2>&1 || sudo useradd -m -s /bin/bash ${COMPUTER_USER})`,
		`echo '${COMPUTER_USER} ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/${COMPUTER_USER} >/dev/null`,
	].join(" && ");
}

/** What to add to the tailnet policy once, so this host (and only it) may sign in to tagged computers as the agent. */
export function policySnippet(source: string): string {
	return JSON.stringify(
		{
			tagOwners: { [COMPUTER_TAG]: ["autogroup:admin"] },
			ssh: [{ action: "accept", src: [source], dst: [COMPUTER_TAG], users: [COMPUTER_USER] }],
		},
		null,
		2,
	);
}

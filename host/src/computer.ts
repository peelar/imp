// The agent's computer, as the owner picks it in Settings: Imp cloud (an E2B sandbox of a chosen size) or a computer
// of theirs on the tailnet. The choice is kept in the host's data directory. Switching moves the agent, its tools and
// its apps to the other machine at once; the machine left behind keeps its files, so switching back picks up there.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Connection } from "@earendil-works/pi-env";
import { Sandbox } from "e2b";
import type { Topics } from "./live.ts";
import type { Machine, MachineProvider, MachineSize } from "./machine.ts";
import { e2bProvider } from "./machine-e2b.ts";
import { machineImage } from "./machine-runtime.ts";
import { probeSsh, sshProvider } from "./machine-ssh.ts";
import {
  COMPUTER_TAG,
  COMPUTER_USER,
  computerCommand,
  policySnippet,
  readTailnet,
  writeKnownHosts,
  type TailnetDevice,
} from "./tailnet.ts";

export const TOPIC = "computer";
const MACHINE_KEY = "owner:local";
const IDLE_SUSPEND_MS = 10 * 60_000;
const KEEP_ALIVE_MS = 60_000;

/** The cloud sizes, all within E2B's free plan (up to 8 vCPUs and 8 GiB). */
export const SIZES = [
  { id: "2c-4096m", label: "2 vCPUs, 4 GB", size: { cpus: 2, memoryMB: 4096 } },
  { id: "4c-8192m", label: "4 vCPUs, 8 GB", size: { cpus: 4, memoryMB: 8192 } },
  { id: "8c-8192m", label: "8 vCPUs, 8 GB", size: { cpus: 8, memoryMB: 8192 } },
] as const;
const DEFAULT_SIZE = SIZES[0];

type Choice =
  | { kind: "cloud"; size: string }
  | { kind: "own"; device: string; home: string };

/** A Linux computer on the tailnet, and why it cannot be the agent's yet ("" when it can). */
export interface ComputerDevice {
  id: string;
  name: string;
  problem: string;
}

export interface ComputerState {
  /** "cloud", "own", "dev" (a development host's fixed machine), or "none". */
  kind: string;
  /** "none" (no computer chosen), "starting", "ready", or "failed" (with `error`). */
  status: string;
  error: string;
  name: string;
  size: string;
  device: string;
  cloudAvailable: boolean;
  sizes: { id: string; label: string }[];
  devices: ComputerDevice[];
  tailnetError: string;
  /** What to run once on a computer, and what to add to the tailnet policy once. */
  command: string;
  policy: string;
}

interface Slot {
  /** The machine's file namespace: equal ids see the same files. */
  readonly id: string;
  readonly provider?: MachineProvider;
  readonly size: MachineSize;
  readonly workspace: string;
  /** Runs before every attempt to ensure the machine, such as refreshing its host keys. */
  readonly before?: () => Promise<void>;
  connection: Connection;
  machine?: Promise<Machine>;
  lastKeepAlive: number;
}

export interface ComputerOptions {
  readonly dataDir: string;
  readonly secret: string;
  readonly topics: Topics;
  /** A development host's machine: fixed, not chosen in Settings. */
  readonly fixed?: MachineProvider;
  /** An E2B API key from the environment; one entered in Settings takes its place. */
  readonly cloudKey?: string;
  readonly tailscale?: string;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** A machine failure in words for Settings: ssh's own diagnostics are kept only for the host's log. */
function explain(failure: unknown): string {
  const text = message(failure);
  if (/Host key verification failed/.test(text)) {
    return "The computer's SSH host key is not the one Tailscale advertises for it, so Imp refused to connect.";
  }
  if (/Permission denied/.test(text))
    return "Tailscale did not let this host sign in. Check the policy rule shown here.";
  if (/failed \(exit 255\)/.test(text))
    return "Could not reach the computer over Tailscale SSH. Check that it is on and that Tailscale SSH is on there.";
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

export function openComputer(options: ComputerOptions) {
  const file = join(options.dataDir, "computer.json");
  // The E2B API key the owner entered in Settings, readable by the host alone.
  const keyFile = join(options.dataDir, "e2b-api-key");
  let cloudKey = existsSync(keyFile)
    ? readFileSync(keyFile, "utf8").trim()
    : (options.cloudKey ?? "");
  const sshDir = join(options.dataDir, "ssh");
  mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  const tailscale = options.tailscale ?? process.env.TAILSCALE ?? "tailscale";
  const proxyCommand = `${tailscale} nc %h %p`;
  const knownHosts = (device: string) =>
    join(sshDir, `${device.replace(/[^a-zA-Z0-9.-]/g, "_")}.known_hosts`);
  const sshOptions = (device: string, home?: string) => ({
    target: `${COMPUTER_USER}@${device}`,
    home,
    knownHostsFile: knownHosts(device),
    hostKeyAlias: device,
    proxyCommand,
  });

  let choice: Choice | undefined = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Choice)
    : cloudKey
      ? { kind: "cloud", size: DEFAULT_SIZE.id }
      : undefined;
  let status = "none";
  let error = "";
  let devices: ComputerDevice[] = [];
  let tailnetError = "";
  let source = "";
  const listeners = new Set<(workspace: string) => Promise<void> | void>();

  function slotFor(next: Choice | undefined): Omit<Slot, "connection"> {
    if (options.fixed)
      return {
        id: "machine:dev",
        provider: options.fixed,
        size: DEFAULT_SIZE.size,
        workspace: options.fixed.workspace(MACHINE_KEY),
        lastKeepAlive: 0,
      };
    if (next?.kind === "cloud") {
      const provider = e2bProvider({
        secret: options.secret,
        apiKey: cloudKey,
      });
      const size = (SIZES.find((s) => s.id === next.size) ?? DEFAULT_SIZE).size;
      return {
        id: `machine:cloud:${next.size}`,
        provider,
        size,
        workspace: provider.workspace(MACHINE_KEY),
        lastKeepAlive: 0,
      };
    }
    if (next?.kind === "own") {
      const provider = sshProvider({
        secret: options.secret,
        ...sshOptions(next.device, next.home),
      });
      // Tailscale may rotate a device's host keys; trust the ones it advertises now.
      const before = async () => {
        const device = (await readTailnet(tailscale)).devices.find(
          (d) => d.dnsName === next.device
        );
        if (!device)
          throw new Error(`${next.device} is no longer on your tailnet.`);
        if (!device.online) throw new Error(`${device.name} is offline.`);
        await writeKnownHosts(knownHosts(next.device), device);
      };
      const id = `machine:own:${next.device}`;
      return {
        id,
        provider,
        size: DEFAULT_SIZE.size,
        workspace: provider.workspace(MACHINE_KEY),
        before,
        lastKeepAlive: 0,
      };
    }
    return {
      id: "machine:none",
      size: DEFAULT_SIZE.size,
      workspace: "/",
      lastKeepAlive: 0,
    };
  }

  function open(next: Choice | undefined): Slot {
    const slot = slotFor(next) as Slot;
    slot.connection = new Connection({
      command: async () => (await ensure(slot)).daemonCommand(),
    });
    return slot;
  }

  const set = (nextStatus: string, nextError: string) => {
    status = nextStatus;
    error = nextError;
    options.topics.changed(TOPIC);
  };

  /** The slot's machine, set up and running. Background retries of a failed machine keep showing the failure. */
  function ensure(slot: Slot, shown = false): Promise<Machine> {
    if (!slot.provider)
      return Promise.reject(
        new Error("Choose a computer for your imp in Settings.")
      );
    if (!slot.machine) {
      if (slot === current && (shown || status !== "failed"))
        set("starting", "");
      const provider = slot.provider;
      slot.machine = (async () => {
        await slot.before?.();
        const image = await provider.prepareImage(
          await machineImage(slot.size)
        );
        return provider.ensure({
          key: MACHINE_KEY,
          image,
          idleSuspendMs: IDLE_SUSPEND_MS,
        });
      })().then(
        (machine) => {
          slot.lastKeepAlive = Date.now();
          if (slot === current) set("ready", "");
          return machine;
        },
        (failure: unknown) => {
          slot.machine = undefined;
          if (slot === current) set("failed", explain(failure));
          throw failure;
        }
      );
    }
    return slot.machine;
  }

  let current = open(choice);

  async function switchTo(next: Choice) {
    choice = next;
    writeFileSync(file, JSON.stringify(next), { mode: 0o600 });
    const previous = current;
    current = open(next);
    set(current.provider ? "starting" : "none", "");
    previous.connection.close();
    previous.provider?.close();
    for (const listener of listeners) await listener(current.workspace);
    void ensure(current, true).catch(() => {});
  }

  function deviceProblem(device: TailnetDevice): string {
    if (!device.tags.includes(COMPUTER_TAG))
      return `Not tagged ${COMPUTER_TAG}`;
    if (device.hostKeys.length === 0) return "Tailscale SSH is off";
    if (!device.online) return "Offline";
    return "";
  }

  async function refreshTailnet() {
    if (options.fixed) return;
    try {
      const tailnet = await readTailnet(tailscale);
      source = tailnet.source;
      devices = tailnet.devices
        .filter((d) => d.os === "linux")
        .map((d) => ({
          id: d.dnsName,
          name: d.name || d.dnsName.split(".")[0]!,
          problem: deviceProblem(d),
        }))
        .sort(
          (a, b) =>
            Number(a.problem !== "") - Number(b.problem !== "") ||
            a.name.localeCompare(b.name)
        );
      tailnetError = "";
    } catch (failure) {
      devices = [];
      tailnetError = message(failure);
    }
  }

  function name(): string {
    const picked = choice;
    if (options.fixed) return "This computer (development)";
    if (picked?.kind === "cloud")
      return `Imp cloud, ${(SIZES.find((s) => s.id === picked.size) ?? DEFAULT_SIZE).label}`;
    if (picked?.kind === "own")
      return (
        devices.find((d) => d.id === picked.device)?.name ??
        picked.device.split(".")[0]!
      );
    return "";
  }

  const ok = { ok: true, error: "" };
  const refused = (reason: string) => ({ ok: false, error: reason });

  return {
    /** The state Settings shows, with the tailnet's devices read again. */
    async load(): Promise<ComputerState> {
      await refreshTailnet();
      return {
        kind: options.fixed ? "dev" : (choice?.kind ?? "none"),
        status: current.provider ? status : "none",
        error,
        name: name(),
        size: choice?.kind === "cloud" ? choice.size : "",
        device: choice?.kind === "own" ? choice.device : "",
        cloudAvailable: cloudKey !== "",
        sizes: SIZES.map(({ id, label }) => ({ id, label })),
        devices,
        tailnetError,
        command: computerCommand(),
        policy: policySnippet(source),
      };
    },
    /** The pi-env connection to the current machine; a switch replaces it. */
    connection: () => current.connection,
    /** The current machine's file namespace. */
    id: () => current.id,
    /** Where the agent works on the current machine. */
    workspace: () => current.workspace,
    /** The current machine, set up and running. */
    machine: () => ensure(current),
    /** The host is using the machine: keep it from suspending, at most once a minute. */
    touch() {
      const slot = current;
      if (!slot.machine || Date.now() - slot.lastKeepAlive < KEEP_ALIVE_MS)
        return;
      slot.lastKeepAlive = Date.now();
      slot.machine
        .then((m) => m.keepAlive())
        .catch((failure) => console.error(`keepAlive: ${message(failure)}`));
    },
    /** Runs after every switch, with the new machine's workspace. */
    onSwitch(listener: (workspace: string) => Promise<void> | void) {
      listeners.add(listener);
    },
    /** Settings asked for the tailnet's devices again. */
    refresh() {
      options.topics.changed(TOPIC);
      return ok;
    },
    retry() {
      void ensure(current, true).catch(() => {});
      return ok;
    },
    async useCloud(size: string) {
      if (options.fixed)
        return refused("This host runs on a fixed development machine.");
      if (!cloudKey) return refused("Add your E2B API key first.");
      if (!SIZES.some((s) => s.id === size))
        return refused(`There is no ${size} size.`);
      if (choice?.kind === "cloud" && choice.size === size) return ok;
      await switchTo({ kind: "cloud", size });
      return ok;
    },
    /** Checks the key with E2B, keeps it, and moves a machine-less agent onto Imp cloud. */
    async setCloudKey(key: string) {
      if (options.fixed)
        return refused("This host runs on a fixed development machine.");
      const trimmed = key.trim();
      if (!/^e2b_[A-Za-z0-9]+$/.test(trimmed))
        return refused(
          "An E2B API key starts with e2b_. Copy it from e2b.dev/dashboard."
        );
      try {
        await Sandbox.list({ apiKey: trimmed }).nextItems();
      } catch (failure) {
        const reason = message(failure);
        if (/unauthori[sz]ed|invalid api key/i.test(reason))
          return refused(
            "E2B did not accept that key. Copy it again from e2b.dev/dashboard."
          );
        return refused(`Could not check the key with E2B: ${reason}`);
      }
      cloudKey = trimmed;
      writeFileSync(keyFile, trimmed, { mode: 0o600 });
      // A cloud machine (or none yet) starts again with the new key; a computer of the owner's stays in use.
      if (!choice || choice.kind === "cloud")
        await switchTo(choice ?? { kind: "cloud", size: DEFAULT_SIZE.id });
      else options.topics.changed(TOPIC);
      return ok;
    },
    async useOwn(dnsName: string) {
      if (options.fixed)
        return refused("This host runs on a fixed development machine.");
      let device: TailnetDevice | undefined;
      try {
        device = (await readTailnet(tailscale)).devices.find(
          (d) => d.dnsName === dnsName
        );
      } catch (failure) {
        return refused(message(failure));
      }
      if (!device)
        return refused("That computer is no longer on your tailnet.");
      const problem = deviceProblem(device);
      if (problem)
        return refused(
          `${device.name} cannot be your imp's computer yet: ${problem}.`
        );
      await writeKnownHosts(knownHosts(dnsName), device);
      const probe = await probeSsh(sshOptions(dnsName));
      if ("error" in probe) {
        return refused(
          probe.denied
            ? `Tailscale did not let this host sign in to ${device.name} as ${COMPUTER_USER}. Add the policy rule shown here to your tailnet policy.`
            : probe.error
        );
      }
      await switchTo({ kind: "own", device: dnsName, home: probe.home });
      return ok;
    },
    close() {
      current.connection.close();
      current.provider?.close();
    },
  };
}

export type Computer = ReturnType<typeof openComputer>;

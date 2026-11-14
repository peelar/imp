// The agent's computer, as the owner picks it in Settings: Imp cloud (an E2B sandbox of a chosen size) or a computer
// of theirs on the tailnet. The choice is kept in the host's data directory (computer-choice.ts). Switching moves the
// agent, its tools and its apps to the other machine at once (computer-machines.ts); the machine left behind keeps
// its files, so switching back picks up there.
import path from "node:path";
import { Sandbox } from "e2b";
import {
  type Choice,
  type ChoiceStore,
  DEFAULT_SIZE,
  openChoice,
  SIZES,
  sizeOf,
} from "./computer-choice.ts";
import {
  machinePlan,
  machineRunner,
  type MachineStatus,
} from "./computer-machines.ts";
import {
  type ComputerDevice,
  deviceProblem,
  type OwnComputers,
  ownComputers,
} from "./computer-tailnet.ts";
import type { Topics } from "./live.ts";
import type { MachineProvider } from "./machine.ts";
import { probeSsh } from "./machine-ssh.ts";
import {
  COMPUTER_USER,
  computerCommand,
  policySnippet,
  type TailnetDevice,
} from "./tailnet.ts";

export const TOPIC = "computer";

export { SIZES } from "./computer-choice.ts";

export type { ComputerDevice } from "./computer-tailnet.ts";

export type ComputerState = {
  /** "dev" is a development host's fixed machine. */
  kind: "cloud" | "own" | "dev" | "none";
  /** "none": no computer chosen. "failed" comes with `error`. */
  status: MachineStatus;
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
};

export type ComputerOptions = {
  readonly dataDir: string;
  readonly secret: string;
  readonly topics: Topics;
  /** A development host's machine: fixed, not chosen in Settings. */
  readonly fixed?: MachineProvider | undefined;
  /** An E2B API key from the environment; one entered in Settings takes its place. */
  readonly cloudKey?: string | undefined;
  readonly tailscale?: string | undefined;
};

type Reply = { readonly ok: boolean; readonly error: string };

const ok: Reply = { ok: true, error: "" };
const refused = (reason: string): Reply => ({ ok: false, error: reason });

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/** What a change of computer in Settings works with. */
type Switching = {
  /** Whether this is a development host, whose machine is not chosen in Settings. */
  readonly fixed: boolean;
  readonly choice: ChoiceStore;
  readonly own: OwnComputers;
  /** Moves the agent to the machine of another choice. */
  readonly switchTo: (next: Choice) => Promise<void>;
  readonly changed: () => void;
};

const FIXED = "This host runs on a fixed development machine.";

async function useCloud({ fixed, choice, switchTo }: Switching, size: string) {
  const picked = choice.get();

  if (fixed) {
    return refused(FIXED);
  }

  if (!choice.cloudKey()) {
    return refused("Add your E2B API key first.");
  }

  if (!SIZES.some((s) => s.id === size)) {
    return refused(`There is no ${size} size.`);
  }

  if (picked?.kind !== "cloud" || picked.size !== size) {
    await switchTo({ kind: "cloud", size });
  }

  return ok;
}

/** Why E2B does not take the key; "" when it does. */
async function keyProblem(key: string) {
  if (!/^e2b_[A-Za-z0-9]+$/.test(key)) {
    return "An E2B API key starts with e2b_. Copy it from e2b.dev/dashboard.";
  }

  try {
    await Sandbox.list({ apiKey: key }).nextItems();

    return "";
  } catch (error) {
    const reason = message(error);

    return /unauthori[sz]ed|invalid api key/i.test(reason)
      ? "E2B did not accept that key. Copy it again from e2b.dev/dashboard."
      : `Could not check the key with E2B: ${reason}`;
  }
}

/** Checks the key with E2B, keeps it, and moves a machine-less agent onto Imp cloud. */
async function setCloudKey(switching: Switching, key: string) {
  const { fixed, choice, switchTo, changed } = switching;

  if (fixed) {
    return refused(FIXED);
  }

  const trimmed = key.trim();
  const problem = await keyProblem(trimmed);

  if (problem) {
    return refused(problem);
  }

  choice.setCloudKey(trimmed);

  const picked = choice.get();

  // A cloud machine (or none yet) starts again with the new key; a computer of the owner's stays in use.
  if (!picked || picked.kind === "cloud") {
    await switchTo(picked ?? { kind: "cloud", size: DEFAULT_SIZE.id });
  } else {
    changed();
  }

  return ok;
}

async function useOwn({ fixed, own, switchTo }: Switching, dnsName: string) {
  if (fixed) {
    return refused(FIXED);
  }

  let device: TailnetDevice | undefined;

  try {
    device = await own.find(dnsName);
  } catch (error) {
    return refused(message(error));
  }

  if (!device) {
    return refused("That computer is no longer on your tailnet.");
  }

  const problem = deviceProblem(device);

  if (problem) {
    return refused(
      `${device.name} cannot be your imp's computer yet: ${problem}.`
    );
  }

  await own.trust(device);

  const probe = await probeSsh(own.sshOptions(dnsName));

  if ("error" in probe) {
    return refused(
      probe.denied
        ? `Tailscale did not let this host sign in to ${device.name} as ${COMPUTER_USER}. Add the policy rule shown here to your tailnet policy.`
        : probe.error
    );
  }

  await switchTo({ kind: "own", device: dnsName, home: probe.home });

  return ok;
}

export function openComputer(options: ComputerOptions) {
  const { fixed } = options;
  const tailscale = options.tailscale ?? process.env.TAILSCALE ?? "tailscale";
  const choice = openChoice(options.dataDir, options.cloudKey);
  const own = ownComputers(path.join(options.dataDir, "ssh"), tailscale);
  const listeners = new Set<(workspace: string) => Promise<void> | void>();

  const changed = () => {
    options.topics.changed(TOPIC);
  };

  const plan = (next: Choice | undefined) =>
    machinePlan(next, {
      secret: options.secret,
      fixed,
      cloudKey: choice.cloudKey,
      own,
    });

  const machines = machineRunner(plan(choice.get()), changed);

  async function switchTo(next: Choice) {
    choice.set(next);
    machines.move(plan(next));

    const { workspace } = machines.current();

    await Promise.all(
      [...listeners].map(async (listener) => {
        await listener(workspace);
      })
    );
    machines.start();
  }

  const switching = {
    fixed: fixed !== undefined,
    choice,
    own,
    switchTo,
    changed,
  };

  function name(picked: Choice | undefined): string {
    if (fixed) {
      return "This computer (development)";
    }

    if (picked?.kind === "cloud") {
      return `Imp cloud, ${sizeOf(picked.size).label}`;
    }

    return picked?.kind === "own" ? own.nameOf(picked.device) : "";
  }

  return {
    /** The state Settings shows, with the tailnet's devices read again. */
    async load(): Promise<ComputerState> {
      if (!fixed) {
        await own.refresh();
      }

      const picked = choice.get();

      return {
        kind: fixed ? "dev" : (picked?.kind ?? "none"),
        ...machines.state(),
        name: name(picked),
        size: picked?.kind === "cloud" ? picked.size : "",
        device: picked?.kind === "own" ? picked.device : "",
        cloudAvailable: choice.cloudKey() !== "",
        sizes: SIZES.map(({ id, label }) => ({ id, label })),
        devices: own.devices(),
        tailnetError: own.error(),
        command: computerCommand(),
        policy: policySnippet(own.source()),
      };
    },
    /** The pi-env connection to the current machine; a switch replaces it. */
    connection: () => machines.current().connection,
    /** The current machine's file namespace. */
    id: () => machines.current().id,
    /** Where the agent works on the current machine. */
    workspace: () => machines.current().workspace,
    /** The current machine, set up and running. */
    machine: machines.machine,
    /** The host is using the machine: keep it from suspending, at most once a minute. */
    touch: machines.touch,
    /** Runs after every switch, with the new machine's workspace. */
    onSwitch: (listener: (workspace: string) => Promise<void> | void) => {
      listeners.add(listener);
    },
    /** Settings asked for the tailnet's devices again. */
    refresh: () => {
      changed();

      return ok;
    },
    retry: () => {
      machines.start();

      return ok;
    },
    useCloud: async (size: string) => await useCloud(switching, size),
    setCloudKey: async (key: string) => await setCloudKey(switching, key),
    useOwn: async (dnsName: string) => await useOwn(switching, dnsName),
    close: machines.close,
  };
}

export type Computer = ReturnType<typeof openComputer>;

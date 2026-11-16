// The machine behind the owner's choice: which provider runs it, and the one the agent works on now, started when
// first needed. A machine left behind by a switch keeps its files, so switching back picks up there.
import { Connection } from "@earendil-works/pi-env";
import { type Choice, DEFAULT_SIZE, sizeOf } from "./choice.ts";
import type { OwnComputers } from "./own.ts";
import {
  containerProvider,
  e2bKeyProblem,
  e2bProvider,
  findContainerRuntime,
  type Machine,
  machineImage,
  type MachineProvider,
  type MachineSize,
  probeSsh,
  sshProvider,
} from "../machine/machine.ts";

const MACHINE_KEY = "owner:local";

/** The container CLI on this machine whose engine answers, or why there is none. */
export const containerRuntime = findContainerRuntime;

export type { ContainerRuntime } from "../machine/machine.ts";

/** Why Imp cloud does not take an API key; "" when it does. */
export const cloudKeyProblem = e2bKeyProblem;

/** Signs in to one of the owner's computers and checks it can be the agent's: its home directory, or why not. */
export const probeOwn = async (own: OwnComputers, dnsName: string) =>
  await probeSsh(own.sshOptions(dnsName));

const IDLE_SUSPEND_MS = 10 * 60_000;
const KEEP_ALIVE_MS = 60_000;

/** A machine the agent could work on, before anything is started. */
export type MachinePlan = {
  /** The machine's file namespace: equal ids see the same files. */
  readonly id: string;
  /** Absent when no computer is chosen yet. */
  readonly provider?: MachineProvider | undefined;
  readonly size: MachineSize;
  /** Where the agent works on the machine. */
  readonly workspace: string;
  /** Runs before every attempt to ensure the machine, such as refreshing its host keys. */
  readonly before?: (() => Promise<void>) | undefined;
};

type Slot = MachinePlan & {
  /** The pi-env connection to the machine, which starts it on first use. */
  readonly connection: Connection;
  machine?: Promise<Machine> | undefined;
  lastKeepAlive: number;
};

export type MachineStatus = "none" | "starting" | "ready" | "failed";

export type PlanOptions = {
  readonly secret: string;
  /** A development host's machine: fixed, not chosen in Settings. */
  readonly fixed: MachineProvider | undefined;
  readonly cloudKey: () => string;
  readonly own: OwnComputers;
};

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/** A machine failure in words for Settings: ssh's own diagnostics are kept only for the host's log. */
function explain(cause: unknown): string {
  const text = message(cause);

  if (text.includes("Host key verification failed")) {
    return "The computer's SSH host key is not the one Tailscale advertises for it, so Imp refused to connect.";
  }

  if (text.includes("Permission denied")) {
    return "Tailscale did not let this host sign in. Your tailnet policy needs the rule in the setup prompt.";
  }

  if (text.includes("failed (exit 255)")) {
    return "Could not reach the computer over Tailscale SSH. Check that it is on and that Tailscale SSH is on there.";
  }

  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

function ownPlan(
  choice: Extract<Choice, { kind: "own" }>,
  { secret, own }: PlanOptions
): MachinePlan {
  const provider = sshProvider({
    secret,
    ...own.sshOptions(choice.device, choice.home),
  });

  return {
    id: `machine:own:${choice.device}`,
    provider,
    size: DEFAULT_SIZE.size,
    workspace: provider.workspace(MACHINE_KEY),
    // Tailscale may rotate a device's host keys; trust the ones it advertises now.
    before: async () => {
      const device = await own.find(choice.device);

      if (!device) {
        throw new Error(`${choice.device} is no longer on your tailnet.`);
      }

      if (!device.online) {
        throw new Error(`${device.name} is offline.`);
      }

      await own.trust(device);
    },
  };
}

/** The machine for a choice. Nothing else in the host names a provider. */
export function machinePlan(
  choice: Choice | undefined,
  options: PlanOptions
): MachinePlan {
  if (options.fixed) {
    return {
      id: "machine:dev",
      provider: options.fixed,
      size: DEFAULT_SIZE.size,
      workspace: options.fixed.workspace(MACHINE_KEY),
    };
  }

  if (choice?.kind === "container") {
    const provider = containerProvider({ secret: options.secret });

    return {
      id: "machine:container",
      provider,
      size: DEFAULT_SIZE.size,
      workspace: provider.workspace(MACHINE_KEY),
    };
  }

  if (choice?.kind === "cloud") {
    const provider = e2bProvider({
      secret: options.secret,
      apiKey: options.cloudKey(),
    });

    return {
      id: `machine:cloud:${choice.size}`,
      provider,
      size: sizeOf(choice.size).size,
      workspace: provider.workspace(MACHINE_KEY),
    };
  }

  if (choice?.kind === "own") {
    return ownPlan(choice, options);
  }

  return { id: "machine:none", size: DEFAULT_SIZE.size, workspace: "/" };
}

/** Sets a planned machine up and starts it. */
async function start(plan: MachinePlan, provider: MachineProvider) {
  await plan.before?.();

  const image = await provider.prepareImage(await machineImage(plan.size));

  return await provider.ensure({
    key: MACHINE_KEY,
    image,
    idleSuspendMs: IDLE_SUSPEND_MS,
  });
}

/** Runs the agent's current machine; `changed` tells Settings that its status changed. */
export function machineRunner(first: MachinePlan, changed: () => void) {
  let status: MachineStatus = "none";
  let error = "";

  const set = (nextStatus: MachineStatus, nextError: string) => {
    status = nextStatus;
    error = nextError;
    changed();
  };

  const open = (plan: MachinePlan): Slot => {
    const slot: Slot = {
      ...plan,
      lastKeepAlive: 0,
      connection: new Connection({
        command: async () => await (await ensure(slot)).daemonCommand(),
      }),
    };

    return slot;
  };

  let current = open(first);

  /** Starts the slot's machine and shows how it went, when the slot is still the current one by then. */
  async function started(slot: Slot, provider: MachineProvider) {
    try {
      const machine = await start(slot, provider);

      slot.lastKeepAlive = Date.now();

      if (slot === current) {
        set("ready", "");
      }

      return machine;
    } catch (error_) {
      slot.machine = undefined;

      if (slot === current) {
        set("failed", explain(error_));
      }

      throw error_;
    }
  }

  /** The slot's machine, set up and running. Background retries of a failed machine keep showing the failure. */
  async function ensure(slot: Slot, shown = false): Promise<Machine> {
    if (!slot.provider) {
      throw new Error("Choose a computer for your imp in Settings.");
    }

    if (!slot.machine) {
      if (slot === current && (shown || status !== "failed")) {
        set("starting", "");
      }

      slot.machine = started(slot, slot.provider);
    }

    return await slot.machine;
  }

  const keepAlive = async (machine: Promise<Machine>) => {
    await (await machine).keepAlive();
  };

  return {
    current: (): Readonly<Slot> => current,
    /** What Settings shows of the current machine. */
    state: () => ({
      status: current.provider ? status : ("none" as const),
      error,
    }),
    /** The current machine, set up and running. */
    machine: async () => await ensure(current),
    /** Starts the current machine for the owner to watch: Settings shows the attempt and how it ends. */
    start: () => {
      ensure(current, true).catch((cause: unknown) => {
        console.error(`computer: ${message(cause)}`);
      });
    },
    /** Makes another machine the current one. The one left behind is disconnected, not deleted. */
    move: (plan: MachinePlan) => {
      const previous = current;

      current = open(plan);
      set(current.provider ? "starting" : "none", "");
      previous.connection.close();
      previous.provider?.close();
    },
    /** The host is using the machine: keep it from suspending, at most once a minute. */
    touch: () => {
      const slot = current;

      if (!slot.machine || Date.now() - slot.lastKeepAlive < KEEP_ALIVE_MS) {
        return;
      }

      slot.lastKeepAlive = Date.now();
      keepAlive(slot.machine).catch((cause: unknown) => {
        console.error(`keepAlive: ${message(cause)}`);
      });
    },
    close: () => {
      current.connection.close();
      current.provider?.close();
    },
  };
}

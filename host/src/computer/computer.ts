// The agent's computer, as the owner picks it in Settings: this machine (a container on the machine the host runs
// on), Imp cloud (an E2B sandbox of a chosen size) or a computer of theirs on the tailnet. The choice is kept in the host's data directory (choice.ts). Switching moves the
// agent, its tools and its apps to the other machine at once (machines.ts); the machine left behind keeps
// its files, so switching back picks up there.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type Choice,
  type ChoiceStore,
  DEFAULT_SIZE,
  openChoice,
  SIZES,
  sizeOf,
} from "./choice.ts";
import {
  cloudKeyProblem,
  type ContainerRuntime,
  containerRuntime,
  machinePlan,
  machineRunner,
  type MachineStatus,
  probeOwn,
} from "./machines.ts";
import {
  type ComputerDevice,
  deviceProblem,
  type OwnComputers,
  ownComputers,
} from "./own.ts";
import type { Topics } from "../live/live.ts";
import type { MachineProvider } from "../machine/machine.ts";
import { TOPIC } from "./shell.ts";
import { COMPUTER_USER, setupPrompt, type TailnetDevice } from "./tailnet.ts";

// What the other parts of the host use of this context's inner files (scripts/boundaries.ts).
export { screenSockets, serveScreenPage } from "./screen.ts";

export type { ScreenSockets } from "./screen.ts";

export { SIZES } from "./choice.ts";

export { computerCalls, computerSource, TOPIC } from "./shell.ts";

export type { ComputerDevice } from "./own.ts";

export type ComputerState = {
  /** "dev" is a development host's fixed machine. */
  kind: "container" | "cloud" | "own" | "dev" | "none";
  /** "none": no computer chosen. "failed" comes with `error`. */
  status: MachineStatus;
  error: string;
  name: string;
  size: string;
  device: string;
  /** Whether a container engine answers on the host's machine, and why not when none does. */
  containerAvailable: boolean;
  containerProblem: string;
  cloudAvailable: boolean;
  sizes: { id: string; label: string }[];
  devices: ComputerDevice[];
  tailnetError: string;
  /** The prompt that has the person's coding agent make a computer of theirs the imp's. */
  setupPrompt: string;
};

export type ComputerOptions = {
  readonly dataDir: string;
  readonly topics: Topics;
  /** A development host's machine, given the host's secret: fixed, not chosen in Settings. */
  readonly fixed?: ((secret: string) => MachineProvider) | undefined;
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

/** How long a look at the tailnet and for a container engine stands before the next state Settings shows looks again. */
const LOOK_MS = 30_000;

/**
 * The tailnet's devices and a container engine on the host's machine, looked for in the background. Settings' state
 * rides on the account stream, which the whole shell waits for when it opens, so it shows what the last look found
 * and never waits on `tailscale status` or `docker info`; a look that finishes tells the shell.
 */
function surroundings(own: OwnComputers, changed: () => void) {
  let at = 0;
  let looking: Promise<void> | undefined;

  let container: ContainerRuntime = {
    ok: false,
    problem: "Looking for Docker, OrbStack or Podman…",
  };

  // Neither read rejects: each says what went wrong in what it found.
  async function lookNow() {
    const [, found] = await Promise.all([own.refresh(), containerRuntime()]);

    container = found;
    at = Date.now();
    looking = undefined;
    changed();
  }

  /** Starts a look unless one is under way or the last still stands. */
  function look() {
    if (!looking && Date.now() - at >= LOOK_MS) {
      looking = lookNow();
      looking.catch((cause: unknown) => {
        looking = undefined;
        console.error(`computer: looking around failed: ${String(cause)}`);
      });
    }
  }

  return {
    look,
    /** What the last look found of a container engine. */
    container: () => container,
    /** Settings asked to look again: the next look starts now, whatever the last one found. */
    again() {
      at = 0;
      look();
    },
    /** A container engine as it answers now, for a switch to one. */
    async fresh() {
      // A look under way may have started before the engine did.
      await looking;
      at = 0;
      look();
      await looking;

      return container;
    },
  };
}

/** A container on the host's machine, once its engine answers. */
async function useContainer(
  { fixed, choice, switchTo }: Switching,
  found: ContainerRuntime
) {
  if (fixed) {
    return refused(FIXED);
  }

  if (!found.ok) {
    return refused(found.problem);
  }

  if (choice.get()?.kind !== "container") {
    await switchTo({ kind: "container" });
  }

  return ok;
}

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

/** Checks the key with E2B, keeps it, and moves a machine-less agent onto Imp cloud. */
async function setCloudKey(switching: Switching, key: string) {
  const { fixed, choice, switchTo, changed } = switching;

  if (fixed) {
    return refused(FIXED);
  }

  const trimmed = key.trim();
  const problem = await cloudKeyProblem(trimmed);

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

  const probe = await probeOwn(own, dnsName);

  if ("error" in probe) {
    return refused(
      probe.denied
        ? `Tailscale did not let this host sign in to ${device.name} as ${COMPUTER_USER}. Your tailnet policy needs the rule in the setup prompt.`
        : probe.error
    );
  }

  await switchTo({ kind: "own", device: dnsName, home: probe.home });

  return ok;
}

/** A stable secret for deriving machine tokens, created on first start. */
function hostSecret(dataDir: string) {
  const file = path.join(dataDir, "host-secret");

  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  }

  return readFileSync(file, "utf-8").trim();
}

export function openComputer(options: ComputerOptions) {
  const secret = hostSecret(options.dataDir);
  const fixed = options.fixed?.(secret);
  const tailscale = options.tailscale ?? "tailscale";
  const choice = openChoice(options.dataDir, options.cloudKey);
  const own = ownComputers(path.join(options.dataDir, "ssh"), tailscale);
  const listeners = new Set<(workspace: string) => Promise<void> | void>();

  const changed = () => {
    options.topics.changed(TOPIC);
  };

  const plan = (next: Choice | undefined) =>
    machinePlan(next, {
      secret,
      fixed,
      cloudKey: choice.cloudKey,
      own,
    });

  const machines = machineRunner(plan(choice.get()), changed);
  // A development host's machine is fixed, so it has nothing to look for. The first look starts with the host, so
  // Settings rarely shows one under way.
  const around = fixed ? undefined : surroundings(own, changed);

  around?.look();

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

    if (picked?.kind === "container") {
      return "This machine";
    }

    if (picked?.kind === "cloud") {
      return `Imp cloud, ${sizeOf(picked.size).label}`;
    }

    return picked?.kind === "own" ? own.nameOf(picked.device) : "";
  }

  return {
    /** The state Settings shows, with what the last look found; one that no longer stands starts again. */
    async load(): Promise<ComputerState> {
      around?.look();

      const picked = choice.get();

      const found: ContainerRuntime = around?.container() ?? {
        ok: false,
        problem: "",
      };

      return {
        kind: fixed ? "dev" : (picked?.kind ?? "none"),
        ...machines.state(),
        name: name(picked),
        size: picked?.kind === "cloud" ? picked.size : "",
        device: picked?.kind === "own" ? picked.device : "",
        containerAvailable: found.ok,
        containerProblem: found.ok ? "" : found.problem,
        cloudAvailable: choice.cloudKey() !== "",
        sizes: SIZES.map(({ id, label }) => ({ id, label })),
        devices: own.devices(),
        tailnetError: own.error(),
        setupPrompt: setupPrompt(own.source()),
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
    /** Settings asked for the tailnet's devices, and the container engine, again: the look shows itself when done. */
    refresh: () => {
      around?.again();

      return ok;
    },
    retry: () => {
      machines.start();

      return ok;
    },
    useCloud: async (size: string) => await useCloud(switching, size),
    setCloudKey: async (key: string) => await setCloudKey(switching, key),
    useOwn: async (dnsName: string) => await useOwn(switching, dnsName),
    useContainer: async () =>
      await useContainer(
        switching,
        (await around?.fresh()) ?? { ok: false, problem: FIXED }
      ),
    close: machines.close,
  };
}

export type Computer = ReturnType<typeof openComputer>;

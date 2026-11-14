// The machine adapter contract. Every provider (E2B, a computer you bring over SSH, and local for development)
// implements it, and nothing else in the host knows which provider runs the agent's computer.
//
// What every adapter guarantees:
// 1. `ensure()` is idempotent per key, resumes a suspended machine, and returns it set up by this host's setup script
//    (machine/setup.sh). What is installed on the machine is decided by the host, never by the provider.
// 2. The machine is durable: its home directory survives suspends, resumes, reboots and host restarts. Running
//    processes may not, so the host checks the machine runtime after every `ensure()` and reloads every app worker
//    after every reconnect.
// 3. An `expose()` endpoint is unreachable without what only the host holds: its headers, or a tunnel it opened.
// 4. Provider credentials stay on the host; nothing on the machine can call the provider's API.
// 5. The owner's secrets stay on the host too: the machine's commands get stand-ins, and their HTTPS requests to a
//    secret's hosts go through `egress()` to the host, which puts the secret on them (egress.ts).

export type MachineProvider = {
  readonly name: string;
  /** Where the agent works on machine `key`: its read, write, edit, and bash tools start here. */
  readonly workspace: (key: string) => string;
  /** Prepare our machine image in this provider's format, such as a template. Idempotent per image. */
  readonly prepareImage: (
    image: ImageSpec,
    signal?: AbortSignal
  ) => Promise<string>;
  /** Create the machine for `spec.key`, or resume and return the existing one, with the machine runtime running. */
  readonly ensure: (
    spec: MachineSpec,
    signal?: AbortSignal
  ) => Promise<Machine>;
  readonly destroy: (key: string, signal?: AbortSignal) => Promise<void>;
  /** The host stops using this provider: close what it holds open, such as tunnels. Machines keep their state. */
  readonly close: () => void;
};

export type ImageSpec = {
  /** The setup script: runs as root on Debian or Ubuntu, and is safe to run again on a machine that ran an older one. */
  readonly setup: string;
  /** What the machine gets, where the provider lets the host choose. A computer you bring is the size it is. */
  readonly size: MachineSize;
};

export type MachineSize = {
  readonly cpus: number;
  readonly memoryMB: number;
};

export type MachineSpec = {
  /** Stable and chosen by the host, such as "owner:adrian". */
  readonly key: string;
  /** What `prepareImage` returned. */
  readonly image: string;
  /** Suspend after this long without `keepAlive()`, where the provider can suspend. */
  readonly idleSuspendMs: number;
};

export type Machine = {
  readonly key: string;
  /**
   * A local command whose stdin and stdout reach a pi-env daemon on the machine. pi-env's `Connection` runs it with
   * `serve --token <hex>` appended, on its first request and again after a lost connection.
   */
  readonly daemonCommand: (signal?: AbortSignal) => Promise<readonly string[]>;
  /** The machine runtime's app socket (agentd's `/apps`): a WebSocket URL and the headers it needs. */
  readonly appSocket: (signal?: AbortSignal) => Promise<Endpoint>;
  /**
   * The machine's screen, a desktop the agent's programs open their windows on: a WebSocket carrying VNC (RFB), and
   * the headers it needs. It closes with a reason when the machine has no screen.
   */
  readonly screen: (signal?: AbortSignal) => Promise<Endpoint>;
  /** An endpoint the host can reach that forwards to `port` on the machine, with the headers it needs. */
  readonly expose: (port: number, signal?: AbortSignal) => Promise<Endpoint>;
  /** The host is using the machine: postpone the idle suspend by another `idleSuspendMs`. */
  readonly keepAlive: (signal?: AbortSignal) => Promise<void>;
  readonly suspend: (signal?: AbortSignal) => Promise<void>;
};

export type Endpoint = {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
};

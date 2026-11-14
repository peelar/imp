# Machines

Every provider of the agent's computer implements one interface, `MachineProvider` in `host/src/machine.ts`. Three exist today:

| Adapter | File | The computer is |
| --- | --- | --- |
| E2B | `host/src/machine-e2b.ts` | One E2B sandbox, found by its key and size. |
| SSH | `host/src/machine-ssh.ts` | A Linux computer you bring, reached with the system `ssh`. |
| Local | `host/src/machine-local.ts` | A directory on the host. Development and tests only. |

## The four guarantees

Every adapter promises these, and the rest of the host relies on them:

1. **`ensure()` is idempotent per key.** It resumes a suspended machine and returns it set up by this host's setup script. What is installed is decided by the host, never by the provider.
2. **The machine is durable.** Its home directory survives suspends, resumes, reboots and host restarts. Running processes may not, so the host checks the runtime after every `ensure()` and reloads every app worker after every reconnect.
3. **An exposed endpoint is unreachable without what only the host holds:** its headers, or a tunnel it opened.
4. **Provider credentials stay on the host.** Nothing on the machine can call the provider's API.

## The interface

```ts
interface MachineProvider {
  readonly name: string;
  /** Where the agent works on machine `key`. */
  workspace(key: string): string;
  /** Prepare the machine image in this provider's format, such as a template. Idempotent per image. */
  prepareImage(image: ImageSpec, signal?: AbortSignal): Promise<string>;
  /** Create the machine for `spec.key`, or resume the existing one, with the runtime running. */
  ensure(spec: MachineSpec, signal?: AbortSignal): Promise<Machine>;
  destroy(key: string, signal?: AbortSignal): Promise<void>;
  /** Stop using this provider: close tunnels. Machines keep their state. */
  close(): void;
}

interface Machine {
  readonly key: string;
  daemonCommand(signal?: AbortSignal): Promise<readonly string[]>; // reaches pi-env
  appSocket(signal?: AbortSignal): Promise<Endpoint>; // agentd's /apps
  screen(signal?: AbortSignal): Promise<Endpoint>; // VNC over a WebSocket
  expose(port: number, signal?: AbortSignal): Promise<Endpoint>;
  keepAlive(signal?: AbortSignal): Promise<void>; // postpone the idle suspend
  suspend(signal?: AbortSignal): Promise<void>;
}
```

An `Endpoint` is a URL and the headers it needs.

## Setup and the runtime

`host/src/machine-runtime.ts` is the provider-independent part. The setup script records its digest on the machine once it succeeds, so an adapter runs it only on a machine whose recorded digest differs. The runtime files (agentd and the app worker) carry a digest too: a host with newer files restarts an older agentd.

Each adapter does the same four things in its own way: run the setup, copy the runtime files, start agentd, and check its health.

- **E2B** bakes the setup into one template per setup version and size, so a new sandbox starts set up. An existing sandbox runs a newer setup in place, because its disk is yours.
- **SSH** runs the setup over SSH when the computer has not run this version, keeps the runtime in `~/.imp`, starts agentd on loopback, and opens its own SSH tunnels to it.

## Adding a provider

Implement `MachineProvider`, keep the four guarantees, and check it with the smoke test, which prepares the image, ensures the machine, runs a command through pi-env, writes and reads a file, loads an app on the app socket, and reaches the screen:

```sh
cd host
MACHINE=e2b node scripts/smoke-machine.ts                  # needs E2B_API_KEY
MACHINE=ssh MACHINE_SSH=imp@homelab node scripts/smoke-machine.ts
MACHINE=local node scripts/smoke-machine.ts
```

Nothing else in the host needs to change. `host/src/computer-machines.ts` is the one file that names the providers, and where Settings picks one.

// The machine adapter contract. Every provider (E2B and local today; Docker, SSH, ... later) implements it, and
// nothing else in the host knows which provider runs the agent's computer.
//
// What every adapter guarantees:
// 1. `ensure()` is idempotent per key and resumes a suspended machine.
// 2. Nothing on the machine has to survive: the host checks the machine runtime after every `ensure()` and reloads
//    every app worker after every reconnect.
// 3. An `expose()` endpoint is unreachable without its headers, which only the host holds.
// 4. Provider credentials stay on the host; nothing on the machine can call the provider's API.

export interface MachineProvider {
	readonly name: string;
	/** Where the agent works on machine `key`: its read, write, edit, and bash tools start here. */
	workspace(key: string): string;
	/** Build our machine image into this provider's format. Idempotent per image digest. */
	prepareImage(image: ImageSpec, signal?: AbortSignal): Promise<string>;
	/** Create the machine for `spec.key`, or resume and return the existing one, with the machine runtime running. */
	ensure(spec: MachineSpec, signal?: AbortSignal): Promise<Machine>;
	destroy(key: string, signal?: AbortSignal): Promise<void>;
}

export interface ImageSpec {
	readonly dockerfile: string;
	readonly context: string;
}

export interface MachineSpec {
	/** Stable and chosen by the host, such as "owner:adrian". */
	readonly key: string;
	/** What `prepareImage` returned. */
	readonly image: string;
	/** Suspend after this long without `keepAlive()`. Nothing on the machine has to survive a suspend. */
	readonly idleSuspendMs: number;
}

export interface Machine {
	readonly key: string;
	/**
	 * A local command whose stdin and stdout reach a pi-env daemon on the machine. pi-env's `Connection` runs it with
	 * `serve --token <hex>` appended, on its first request and again after a lost connection.
	 */
	daemonCommand(signal?: AbortSignal): Promise<readonly string[]>;
	/** The machine runtime's app socket (agentd's `/apps`): a WebSocket URL and the headers it needs. */
	appSocket(signal?: AbortSignal): Promise<Endpoint>;
	/** An endpoint the host can reach that forwards to `port` on the machine, with the headers it needs. */
	expose(port: number, signal?: AbortSignal): Promise<Endpoint>;
	/** The host is using the machine: postpone the idle suspend by another `idleSuspendMs`. */
	keepAlive(signal?: AbortSignal): Promise<void>;
	suspend(signal?: AbortSignal): Promise<void>;
}

export interface Endpoint {
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
}

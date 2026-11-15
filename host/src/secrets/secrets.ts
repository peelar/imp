// The owner's secrets, which their imp uses on its computer without holding them. The owner adds them in Settings, and
// the vault keeps them (vault.ts). There are two kinds:
//
//   key     an API key. The egress proxy puts it on the agent's HTTPS requests to its hosts (egress.ts); on the
//           machine it is only a stand-in, in the variables its service's tools read, such as
//           GITHUB_TOKEN=imp-secret-github.
//   login   a website's username, password and, optionally, one-time-code key. The host types it into the agent's
//           Chrome, on a page of the login's site only, when the agent calls sign_in (logins.ts).
//
// The agent sees names, hosts and sites, never a value, and asks the owner for a secret it lacks with request_secret,
// never in the chat (tools.ts).
import type { Registry } from "@earendil-works/pi-durable";
import { type Egress, openEgress } from "./egress.ts";
import type { EgressRule, EgressRules, EgressUse } from "./egress-proxy.ts";
import type { Topics } from "../kernel/live.ts";
import type { Machine } from "../machine/machine.ts";
import {
  type Described,
  described,
  type KeyInput,
  newKey,
} from "./descriptions.ts";
import { type LoginInput, newLogin, signIn, storeLogin } from "./logins.ts";
import { secretRecords } from "./records.ts";
import { secretsExtension } from "./tools.ts";
import { secretsState, type SecretsState } from "./view.ts";
import { openVault, type Vault } from "./vault.ts";

export const TOPIC = "secrets";

export type SecretsOptions = {
  readonly dataDir: string;
  readonly toolsDir: string;
  readonly topics: Topics;
  readonly registry: Registry;
  /** The agent's current machine, started if it must be. */
  readonly machine: () => Promise<Machine>;
};

const ok = { ok: true, error: "" };
const refused = (error: string) => ({ ok: false, error });

const why = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/** The API keys among the secrets: the ones the egress proxy puts on requests. */
const keysOf = (secrets: readonly Described[]) =>
  secrets.filter((secret) => secret.kind === "key");

/** Which key goes on which host's requests, and every key's stand-in. */
function egressRules(secrets: readonly Described[]): EgressRules {
  const hosts = new Map<string, EgressRule[]>();
  const keys = keysOf(secrets);

  for (const secret of keys) {
    for (const { host, ...rule } of secret.rules) {
      hosts.set(host, [
        ...(hosts.get(host) ?? []),
        { secret: secret.name, ...rule },
      ]);
    }
  }

  return {
    hosts: Object.fromEntries(hosts),
    standIns: Object.fromEntries(
      keys.map((secret) => [secret.name, secret.standIn])
    ),
  };
}

/** Each key's stand-in, under the variables its service's tools read. */
const standIns = (secrets: readonly Described[]) =>
  Object.fromEntries(
    keysOf(secrets).flatMap((secret) =>
      secret.env.map((name): [string, string] => [name, secret.standIn])
    )
  );

type Listed = {
  readonly vault: Vault;
  readonly egress: Egress;
  readonly changed: () => void;
};

/** The secrets' descriptions as the vault holds them, which the egress proxy gets the rules of on every read. */
function secretList({ vault, egress, changed }: Listed) {
  let secrets: readonly Described[] = [];
  let loaded: Promise<void> | undefined;
  /** Whether the secrets have been read from the vault since the host started. */
  let listed = false;

  /** Reads the secrets' descriptions from the vault, and gives the egress proxy their rules. */
  const reload = async () => {
    const stored = await vault.list();

    secrets = stored
      .flatMap((secret) => described(secret) ?? [])
      .toSorted((a, b) => a.name.localeCompare(b.name));
    egress.setRules(egressRules(secrets));
    listed = true;
    changed();
  };

  const loadOnce = async () => {
    try {
      await reload();
    } catch (cause) {
      loaded = undefined;
      changed();

      throw cause;
    }
  };

  return {
    all: () => secrets,
    listed: () => listed,
    reload,
    /** The vault running and the secrets read, once; a failure is shown in Settings and tried again on the next call. */
    load: async () => {
      loaded ??= loadOnce();
      await loaded;
    },
  };
}

type CommandEnv = {
  readonly list: ReturnType<typeof secretList>;
  readonly egress: Egress;
  readonly machine: () => Promise<Machine>;
};

async function commandEnv({
  list,
  egress,
  machine,
}: CommandEnv): Promise<Record<string, string>> {
  try {
    await list.load();
  } catch {
    // Settings shows why; the command runs with the secrets read so far, which may be none.
  }

  const secrets = list.all();

  if (keysOf(secrets).length === 0) {
    return {};
  }

  try {
    const running = await machine();

    const [{ env }] = await Promise.all([
      running.egress(),
      egress.connect(running),
    ]);

    return { ...env, ...standIns(secrets) };
  } catch (cause) {
    // The command still runs; its requests to a secret's hosts fail with the proxy's reason.
    console.error(`secrets: ${why(cause)}`);

    return standIns(secrets);
  }
}

export function openSecrets(options: SecretsOptions) {
  const { dataDir, toolsDir } = options;
  const vault = openVault({ dataDir, toolsDir });
  const records = secretRecords(dataDir);

  const changed = () => {
    options.topics.changed(TOPIC);
  };

  const used = (use: EgressUse) => {
    records.used(use);
    changed();
  };

  const egress = openEgress({ dataDir, toolsDir, vault, onUse: used });

  const list = secretList({ vault, egress, changed });

  // The agent's side: what it may use, and how to ask for more.
  options.registry.install(
    secretsExtension({
      secrets: list.all,
      ask: (request) => {
        records.ask(request);
        changed();
      },
      signIn: async (login) =>
        await signIn(login, { vault, machine: options.machine, used }),
    })
  );

  /** A change to the vault's secrets, read back afterwards; a failure is the answer Settings shows. */
  const change = async (apply: () => Promise<void>) => {
    try {
      await list.load();
      await apply();
      await list.reload();

      return ok;
    } catch (cause) {
      return refused(why(cause));
    }
  };

  return {
    /** Starts the vault in the background, so Settings has the secrets when it opens. */
    start: () => {
      list.load().catch((cause: unknown) => {
        console.error(`secrets: ${why(cause)}`);
      });
    },
    /** What Settings shows. */
    state: (): SecretsState =>
      secretsState({
        vault: vault.state(),
        listed: list.listed(),
        secrets: list.all(),
        requests: records.requests(),
        uses: records.uses(),
      }),
    /**
     * Adds a secret, or replaces one's value (an empty value keeps it). For "other", `hosts` (comma-separated),
     * `header`, `prefix` and `envName` say where it goes; a service fills them in itself.
     */
    put: async (input: KeyInput) => {
      const key = newKey(input, list.all());

      if (!key.ok) {
        return refused(key.error);
      }

      return await change(async () => {
        await vault.put(
          key.name,
          key.value ? { value: key.value } : undefined,
          key.meta
        );
        records.answered(key.name);
      });
    },
    /** Adds a login, or changes one: an empty password or one-time-code key keeps the one it has. */
    putLogin: async (input: LoginInput) => {
      const login = newLogin(input, list.all());

      if (!login.ok) {
        return refused(login.error);
      }

      return await change(async () => {
        await storeLogin(vault, login);
        records.answered(login.name);
      });
    },
    remove: async (name: string) =>
      await change(async () => {
        await vault.remove(name);
      }),
    /** The owner turns down a key the imp asked for. */
    dismiss: (id: string) => {
      records.dismiss(id);
      changed();

      return ok;
    },
    /**
     * What every command on the machine gets in its environment: each secret's stand-in, and the egress proxy with the
     * control socket to the machine open. Nothing, and no machine started, while there are no API keys.
     */
    shellEnv: async () =>
      await commandEnv({ list, egress, machine: options.machine }),
    /** The agent moved to another machine. */
    switched: () => {
      egress.disconnect();
    },
    close: () => {
      egress.close();
      vault.close();
    },
  };
}

export type Secrets = ReturnType<typeof openSecrets>;

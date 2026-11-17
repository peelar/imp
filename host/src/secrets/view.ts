// What Settings shows about the owner's secrets: each key's name, hosts and variables, each login's site and username,
// what the imp asked for, the latest uses, and the services to pick from. Never a value.
import type { Described } from "./descriptions.ts";
import type { KeyRequest, RecordedUse } from "./records.ts";
import { hostsOf, SERVICES, variables } from "./services.ts";

const USES_SHOWN = 12;

type SecretView = {
  readonly name: string;
  /** "key" or "login". */
  readonly kind: string;
  readonly service: string;
  readonly label: string;
  readonly hosts: string;
  readonly env: string;
  readonly standIn: string;
  /** A login's site and username ("" for a key). */
  readonly site: string;
  readonly username: string;
  /** One line on what it is for: a key's hosts and variables, or a login's site and username. */
  readonly detail: string;
  readonly updated: string;
  readonly lastUsed: string;
};

export type SecretsState = {
  /** "starting" (the vault is being set up), "ready", or "failed" (with `error`). */
  readonly status: string;
  readonly error: string;
  readonly secrets: readonly SecretView[];
  readonly requests: readonly KeyRequest[];
  readonly uses: readonly {
    readonly id: string;
    readonly secret: string;
    readonly what: string;
    /** "200", "typed" for a sign-in, or "failed". */
    readonly result: string;
    readonly failed: boolean;
    readonly when: string;
  }[];
  readonly services: readonly {
    readonly id: string;
    readonly label: string;
    readonly hosts: string;
    readonly env: string;
  }[];
};

export type SecretsSnapshot = {
  readonly vault: { readonly status: string; readonly error: string };
  /** Whether the secrets have been read from the vault since the host started. */
  readonly listed: boolean;
  readonly secrets: readonly Described[];
  readonly requests: readonly KeyRequest[];
  /** Oldest first. */
  readonly uses: readonly RecordedUse[];
};

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
function ago(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);

  if (!Number.isFinite(ms)) {
    return "";
  }

  if (ms < 60_000) {
    return "just now";
  }

  if (ms < 3_600_000) {
    return `${Math.floor(ms / 60_000)} min ago`;
  }

  if (ms < 86_400_000) {
    return `${Math.floor(ms / 3_600_000)} h ago`;
  }

  const days = Math.floor(ms / 86_400_000);

  return days === 1 ? "yesterday" : `${days} days ago`;
}

function detail(secret: Described) {
  if (secret.kind === "login") {
    return `${secret.site} · ${secret.username}${secret.otp ? " · one-time codes" : ""}`;
  }

  return `${hostsOf(secret.rules)} · ${variables(secret.env)}`;
}

/** Who the host sent a request for: an app ("github"), or an MCP server's connection ("mcp:linear"). */
function byWhom(label: string) {
  if (label === "") {
    return "";
  }

  return label.startsWith("mcp:")
    ? ` · ${label.slice("mcp:".length)} MCP server`
    : ` · ${label} app`;
}

/** One recorded use, as a row: a request it went on, or a sign-in it typed. */
function useRow(use: RecordedUse) {
  const signIn = use.method === "sign in";
  let result = String(use.status);

  if (use.status === 0) {
    result = "failed";
  } else if (signIn) {
    result = "typed";
  }

  return {
    id: use.id,
    secret: use.secret,
    what: signIn
      ? `sign in on ${use.host}`
      : `${use.method} ${use.host}${use.path}${byWhom(use.app ?? "")}`,
    result,
    failed: use.status === 0 || use.status >= 400,
    when: ago(use.at),
  };
}

function status({ vault, listed }: SecretsSnapshot) {
  if (vault.status === "failed") {
    return "failed";
  }

  return listed ? "ready" : "starting";
}

export function secretsState(snapshot: SecretsSnapshot): SecretsState {
  const { vault, secrets, requests, uses } = snapshot;
  const lastUse = new Map(uses.map((use) => [use.secret, use.at]));

  const lastUsed = (name: string) => {
    const at = lastUse.get(name);

    return at ? ago(at) : "";
  };

  return {
    status: status(snapshot),
    error: vault.error,
    secrets: secrets.map((secret) => ({
      name: secret.name,
      kind: secret.kind,
      service: secret.service,
      label:
        SERVICES.find((service) => service.id === secret.service)?.label ??
        secret.name,
      hosts: hostsOf(secret.rules),
      env: variables(secret.env),
      standIn: secret.standIn,
      site: secret.site,
      username: secret.username,
      detail: detail(secret),
      updated: ago(secret.updated),
      lastUsed: lastUsed(secret.name),
    })),
    requests,
    uses: uses.slice(-USES_SHOWN).toReversed().map(useRow),
    services: SERVICES.map((service) => ({
      id: service.id,
      label: service.label,
      hosts: hostsOf(service.rules),
      env: variables(service.env),
    })),
  };
}

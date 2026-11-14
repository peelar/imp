// What Settings shows about the owner's secrets: each one's name, hosts and variables, the keys the imp asked for,
// the latest uses, and the services to pick from. Never a value.
import type { Described } from "./secret-descriptions.ts";
import type { KeyRequest, RecordedUse } from "./secret-records.ts";
import { hostsOf, SERVICES, variables } from "./secret-services.ts";

const USES_SHOWN = 12;

export type SecretView = {
  readonly name: string;
  readonly service: string;
  readonly label: string;
  readonly hosts: string;
  readonly env: string;
  readonly standIn: string;
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
    readonly status: number;
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
      service: secret.service,
      label:
        SERVICES.find((service) => service.id === secret.service)?.label ??
        secret.name,
      hosts: hostsOf(secret.rules),
      env: variables(secret.env),
      standIn: secret.standIn,
      updated: ago(secret.updated),
      lastUsed: lastUsed(secret.name),
    })),
    requests,
    uses: uses
      .slice(-USES_SHOWN)
      .toReversed()
      .map((use) => ({
        id: use.id,
        secret: use.secret,
        what: `${use.method} ${use.host}${use.path}`,
        status: use.status,
        failed: use.status === 0 || use.status >= 400,
        when: ago(use.at),
      })),
    services: SERVICES.map((service) => ({
      id: service.id,
      label: service.label,
      hosts: hostsOf(service.rules),
      env: variables(service.env),
    })),
  };
}

// A secret's description: its name, its kind, its service, the hosts and header a key's value goes on, the variables
// its stand-in is in, and the stand-in; for a login, its site and username (logins.ts). The vault keeps it
// beside the value, as strings (vault.ts). This file reads it back, and works out the description of a key the owner
// adds in Settings, or why it cannot be added.
import { arr, compile, obj, opt, str } from "@earendil-works/pi-schema";
import { type HostRule, hostsOf, SERVICES } from "./services.ts";
import type { StoredSecret } from "./vault.ts";

export const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

export const HOST =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const HEADER = /^[A-Za-z0-9-]{1,64}$/;

/** Where a secret goes: the headers it is put in, and the variables that hold its stand-in. */
type Placement = {
  readonly rules: readonly HostRule[];
  readonly env: readonly string[];
};

export type Described = Placement & {
  readonly name: string;
  /** "key": an API key the egress proxy puts on requests. "login": a website's, which the host types into Chrome. */
  readonly kind: "key" | "login";
  readonly service: string;
  readonly standIn: string;
  /** A login's site and username; "" for a key. */
  readonly site: string;
  readonly username: string;
  /** Whether a login has a key for one-time codes. */
  readonly otp: boolean;
  readonly updated: string;
};

/** What the owner fills in for a key in Settings. For a service, only `name` and `value` matter. */
export type KeyInput = {
  readonly name: string;
  readonly service: string;
  /** Empty keeps the current value. */
  readonly value: string;
  /** For "other": comma-separated host names. */
  readonly hosts: string;
  readonly header: string;
  readonly prefix: string;
  readonly envName: string;
};

/** A key ready for the vault, or why it is not. */
export type NewKey =
  | {
      readonly ok: true;
      readonly name: string;
      readonly value: string;
      readonly meta: Readonly<Record<string, string>>;
    }
  | Refused;

export type Refused = { readonly ok: false; readonly error: string };

type Placed = ({ readonly ok: true } & Placement) | Refused;

const rulesJson = compile(
  arr(obj({ host: str(), header: str(), prefix: str(), basicUser: opt(str()) }))
);

const refused = (error: string): Refused => ({ ok: false, error });
const standInFor = (name: string) => `imp-secret-${name}`;

const envFor = (name: string) =>
  `${name.toUpperCase().replaceAll("-", "_")}_API_KEY`;

/** The rules a description holds, as the host wrote them; undefined when they are not that. */
function storedRules(written: string) {
  let rules: unknown;

  try {
    rules = JSON.parse(written);
  } catch {
    // Not JSON: no rules.
  }

  return rulesJson.check(rules) ? rules : undefined;
}

/** A stored secret's description; undefined when the vault holds one the host did not write. */
export function described(stored: StoredSecret): Described | undefined {
  const { meta, name, updated } = stored;
  const rules = storedRules(meta.rules ?? "[]");

  return rules
    ? {
        name,
        kind: meta.kind === "login" ? "login" : "key",
        service: meta.service ?? "other",
        rules,
        env: (meta.env ?? "").split(",").filter(Boolean),
        standIn: meta.standIn ?? standInFor(name),
        site: meta.site ?? "",
        username: meta.username ?? "",
        otp: meta.otp === "yes",
        updated,
      }
    : undefined;
}

/** Where a key the owner describes themselves goes: the hosts, header and variable they named. */
function ownPlacement(name: string, input: KeyInput): Placed {
  const hosts = input.hosts
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);

  if (hosts.length === 0 || !hosts.every((host) => HOST.test(host))) {
    return refused("Name the hosts the key is for, such as api.example.com.");
  }

  const header = input.header.trim() || "Authorization";

  if (!HEADER.test(header)) {
    return refused(`${header} is not a header name.`);
  }

  const envName = input.envName.trim() || envFor(name);

  if (!ENV_NAME.test(envName)) {
    return refused(
      `${envName} is not a variable name: use capitals, digits and _.`
    );
  }

  // A word before the key (Bearer, Token) is followed by a space, whether or not the owner typed one.
  const prefix = input.prefix.trim() === "" ? "" : `${input.prefix.trim()} `;

  return {
    ok: true,
    rules: hosts.map((host) => ({ host, header, prefix })),
    env: [envName],
  };
}

function placement(
  name: string,
  input: KeyInput,
  existing: Described | undefined
): Placed {
  const service = SERVICES.find((known) => known.id === input.service);

  if (service) {
    return { ok: true, rules: service.rules, env: service.env };
  }

  if (input.service !== "other") {
    return refused(`There is no service ${input.service}.`);
  }

  // A new value for a key the owner added: it keeps where it goes.
  if (existing?.service === "other" && input.hosts.trim() === "") {
    return { ok: true, rules: existing.rules, env: existing.env };
  }

  return ownPlacement(name, input);
}

/** Why a key cannot go there: another secret already uses one of its variables, or one of its hosts' headers. */
function conflict(others: readonly Described[], { rules, env }: Placement) {
  for (const other of others) {
    const shared = other.env.find((name) => env.includes(name));

    if (shared) {
      return `${other.name} already uses ${shared}.`;
    }
  }

  const sameHeader = (mine: HostRule, theirs: HostRule) =>
    mine.host === theirs.host &&
    mine.header.toLowerCase() === theirs.header.toLowerCase();

  const taken = others.find((other) =>
    other.rules.some((theirs) => rules.some((mine) => sameHeader(mine, theirs)))
  );

  return taken
    ? `${taken.name} already goes on ${hostsOf(taken.rules)}.`
    : undefined;
}

/** The key the owner filled in, checked against the secrets there are, as the vault will keep it. */
export function newKey(input: KeyInput, secrets: readonly Described[]): NewKey {
  const name = input.name.trim().toLowerCase();
  const value = input.value.trim();

  if (!NAME.test(name)) {
    return refused(
      "Name it with lowercase letters, digits and dashes, such as github."
    );
  }

  const existing = secrets.find((secret) => secret.name === name);

  if (existing?.kind === "login") {
    return refused(`${name} is a login.`);
  }

  if (!existing && value === "") {
    return refused("Paste the key first.");
  }

  if (/[\r\n]/.test(value)) {
    return refused("A key is one line.");
  }

  const placed = placement(name, input, existing);

  if (!placed.ok) {
    return placed;
  }

  const others = secrets.filter((secret) => secret.name !== name);
  const taken = conflict(others, placed);

  if (taken) {
    return refused(taken);
  }

  return {
    ok: true,
    name,
    value,
    meta: {
      kind: "key",
      service: input.service,
      rules: JSON.stringify(placed.rules),
      env: placed.env.join(","),
      standIn: standInFor(name),
    },
  };
}

// The owner's website logins: a site, a username, a password and optionally the key its one-time codes come from
// (secret-otp.ts). This file checks a login the owner adds in Settings, and signs the agent in with one: the host
// reads the password back from the vault, the one place in the host that does, and types it into the page Chrome has
// open on the login's site (chrome.ts). The agent sees what was typed into, never what.
import { fillLogin } from "./chrome.ts";
import type { EgressUse } from "./egress-proxy.ts";
import type { Machine } from "./machine.ts";
import {
  type Described,
  HOST,
  NAME,
  type Refused,
} from "./secret-descriptions.ts";
import { otpKey, otpLink, totp } from "./secret-otp.ts";
import type { Vault } from "./vault.ts";

/** What the owner fills in for a login in Settings. */
export type LoginInput = {
  /** Empty: named after the site. */
  readonly name: string;
  /** A host name, or a page's address on it. */
  readonly site: string;
  readonly username: string;
  /** Empty keeps the current password. */
  readonly password: string;
  /** An otpauth:// link or a base32 key; empty keeps the current one. */
  readonly otp: string;
};

/** A login ready for the vault: the fields to store (only those the owner changed) and its description. */
export type NewLogin =
  | {
      readonly ok: true;
      readonly name: string;
      readonly changed: Readonly<Record<string, string>>;
      /** Whether the stored fields not in `changed` must be kept. */
      readonly keeps: boolean;
      readonly meta: Readonly<Record<string, string>>;
    }
  | Refused;

const refused = (error: string): Refused => ({ ok: false, error });

/** "github.com" from "github.com" or "https://github.com/login"; undefined when it names no host. */
export function siteOf(text: string): string | undefined {
  const trimmed = text.trim().toLowerCase();

  const url = URL.parse(
    /^[a-z]+:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
  );

  return url && HOST.test(url.hostname) ? url.hostname : undefined;
}

/** A login's name from its site: "github-login" for github.com, "accounts-google-login" for accounts.google.com. */
export const loginName = (site: string) =>
  `${site
    .replace(/^www\./, "")
    .split(".")
    .slice(0, -1)
    .join("-")
    .slice(0, 33)}-login`;

/** The login the owner filled in, checked against the secrets there are. */
export function newLogin(
  input: LoginInput,
  secrets: readonly Described[]
): NewLogin {
  const site = siteOf(input.site);

  if (!site) {
    return refused("Name the site, such as github.com.");
  }

  const name = input.name.trim().toLowerCase() || loginName(site);
  const username = input.username.trim();
  const existing = secrets.find((secret) => secret.name === name);

  if (!NAME.test(name)) {
    return refused(
      "Name it with lowercase letters, digits and dashes, such as github-login."
    );
  }

  if (existing && existing.kind !== "login") {
    return refused(`${name} is an API key.`);
  }

  if (
    username === "" ||
    /[\r\n]/.test(username) ||
    /[\r\n]/.test(input.password)
  ) {
    return refused(
      "Write the username and password you sign in with, each on one line."
    );
  }

  if (!existing && input.password === "") {
    return refused("Write the password first.");
  }

  const key = input.otp.trim() ? otpKey(input.otp) : undefined;

  if (key && !key.ok) {
    return key;
  }

  const changed: Record<string, string> = {};

  if (input.password) {
    changed.value = input.password;
  }

  if (key) {
    changed.otp = otpLink(key);
  }

  const otp = key !== undefined || existing?.otp === true;

  return {
    ok: true,
    name,
    changed,
    keeps: existing !== undefined && Object.keys(changed).length < 2,
    meta: {
      kind: "login",
      service: "login",
      site,
      username,
      otp: otp ? "yes" : "no",
    },
  };
}

/** Writes a checked login to the vault; a field the owner left empty keeps what the vault holds. */
export async function storeLogin(
  vault: Vault,
  login: Extract<NewLogin, { ok: true }>
) {
  const changing = Object.keys(login.changed).length > 0;
  const kept = login.keeps && changing ? await vault.read(login.name) : {};

  await vault.put(
    login.name,
    changing ? { ...kept, ...login.changed } : undefined,
    login.meta
  );
}

export type SignInOptions = {
  readonly vault: Vault;
  readonly machine: () => Promise<Machine>;
  readonly used: (use: EgressUse) => void;
};

/** The current code of a login's stored key, when it has one. */
function codeOf(stored: Readonly<Record<string, string>>) {
  const key = stored.otp ? otpKey(stored.otp) : undefined;

  return key?.ok ? totp(key) : undefined;
}

/** Types `login` into the page Chrome has open on its site; answers what the agent reads. */
export async function signIn(
  login: Described,
  { vault, machine, used }: SignInOptions
) {
  const running = await machine();
  const stored = await vault.read(login.name);

  const filled = await fillLogin(await running.chrome(), {
    site: login.site,
    username: login.username,
    password: stored.value ?? "",
    code: codeOf(stored),
  }).catch((cause: unknown) => ({
    url: "",
    typed: [],
    after: "",
    error: cause instanceof Error ? cause.message : String(cause),
  }));

  const host = URL.parse(filled.url)?.hostname ?? login.site;

  used({
    secret: login.name,
    method: "sign in",
    host,
    path: "",
    status: filled.error ? 0 : 1,
    error: filled.error,
  });

  if (filled.error && !filled.url) {
    return `${filled.error} Open the site's sign-in page first, such as agent-browser open https://${login.site}/login, then call sign_in again.`;
  }

  if (filled.error) {
    return filled.error;
  }

  const typed = new Intl.ListFormat("en").format(filled.typed);

  return `Typed the ${typed} on ${filled.url} and pressed Enter. The page is now ${filled.after || "loading"}. If it asks for more on the next page, call sign_in again; you never see what was typed.`;
}

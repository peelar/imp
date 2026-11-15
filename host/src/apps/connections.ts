// What an app reads from outside: the services it names in `connections`, the rules every `app.fetch` follows, and
// how often its sync may run (sdk/app.ts). manifest.ts checks a version's connections and interval when it loads;
// `checkFetch` holds each request to them before the host sends it.
//
// The rules, for the first version of live apps: an app only reads. It reaches a host it names, over HTTPS on 443,
// with GET or HEAD, or POST to the one path its connection names as `query` (GraphQL APIs take reads by POST). A
// connection that names a key needs that key, for that host. The host refuses a name that resolves to a loopback,
// private or link-local address, so an app cannot reach the host's own network, and follows no redirect.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { arr, compile, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { Connection, SyncEvery } from "../../../sdk/app.ts";
import type { FetchRequest, ReportedManifest } from "./protocol.ts";

export const EVERY_MS: Readonly<Record<SyncEvery, number>> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

/** The same names Settings takes for a secret's hosts and name (secrets/descriptions.ts). */
const HOST =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const SECRET = /^[a-z][a-z0-9-]{0,39}$/;
const QUERY = /^\/[\w\-./]*$/;

const connectionList = compile(
  arr(obj({ host: str(), secret: opt(str()), query: opt(str()) }))
);

const every = compile(oneOf(["15m", "1h", "6h", "1d"]));

/** A version's connections when they follow the rules; else reports each one they break. */
export function checkConnections(
  reported: ReportedManifest["connections"],
  report: (problem: string) => void
): Connection[] | undefined {
  if (reported === undefined) {
    return [];
  }

  if (!connectionList.check(reported)) {
    report(
      "connections must be a list of { host, secret?, query? }, each a text"
    );

    return undefined;
  }

  const problems: string[] = [];
  const seen = new Set<string>();

  for (const { host, secret, query } of reported) {
    if (!HOST.test(host)) {
      problems.push(`${host} is not a host name, such as api.github.com`);
    }

    if (seen.has(host)) {
      problems.push(`${host} is listed twice`);
    }

    seen.add(host);

    if (secret !== undefined && !SECRET.test(secret)) {
      problems.push(
        `${host}'s secret must be a key's name, such as github: lowercase letters, digits and dashes`
      );
    }

    if (query !== undefined && !QUERY.test(query)) {
      problems.push(`${host}'s query must be a path, such as /graphql`);
    }
  }

  for (const problem of problems) {
    report(`connections: ${problem}`);
  }

  return problems.length === 0 ? reported : undefined;
}

/** A sync's interval, `{}` without a sync; undefined after reporting why it is not one. */
export function checkEvery(
  reported: ReportedManifest["every"],
  report: (problem: string) => void
): { every?: SyncEvery } | undefined {
  if (reported === undefined) {
    return {};
  }

  if (!every.check(reported)) {
    report(`sync.every must be one of ${Object.keys(EVERY_MS).join(", ")}`);

    return undefined;
  }

  return { every: reported };
}

/** The most URLs an app may watch: each is asked every minute or so. */
const MAX_WATCHED = 5;

const urls = compile(arr(str(), { maxItems: MAX_WATCHED }));

/**
 * A sync's watched URLs, `[]` for none; undefined after reporting why they are not: each a GET over HTTPS to one of
 * the app's connections.
 */
export function checkWatch(
  reported: ReportedManifest["watch"],
  connections: readonly Connection[],
  report: (problem: string) => void
): string[] | undefined {
  if (reported === undefined) {
    return [];
  }

  if (!urls.check(reported)) {
    report(`sync.watch must be a list of at most ${MAX_WATCHED} URLs`);

    return undefined;
  }

  const wrong = reported.filter((watched) => {
    const url = URL.parse(watched);

    return (
      url?.protocol !== "https:" ||
      (url.port !== "" && url.port !== "443") ||
      !connections.some(({ host }) => host === url.hostname)
    );
  });

  for (const watched of wrong) {
    report(
      `sync.watch: ${watched} must be an https URL on one of the app's connections`
    );
  }

  return wrong.length === 0 ? reported : undefined;
}

/** What a request may be sent as: its URL, and the key that goes on it, if any. */
export type Checked = {
  readonly url: URL;
  readonly secret: string | undefined;
  /** The address the host's name resolved to, which a request without a key connects to. */
  readonly address: string;
};

export type FetchRules = {
  readonly app: string;
  readonly connections: readonly Connection[];
  /** The hosts a key goes on; undefined when the owner has no key of that name. */
  readonly keyHosts: (secret: string) => readonly string[] | undefined;
  /** Every address a host name resolves to. */
  readonly resolve?: ((host: string) => Promise<string[]>) | undefined;
};

const resolveAll = async (host: string) =>
  (await lookup(host, { all: true })).map((entry) => entry.address);

/**
 * Whether an address is the host's own or its network's: loopback, private, link-local, unspecified, or the shared
 * range Tailscale's addresses are in.
 */
export function isInternal(address: string): boolean {
  const ip = address.toLowerCase();

  if (isIP(ip) !== 6) {
    return isInternalV4(ip);
  }

  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)?.[1];

  return mapped
    ? isInternalV4(mapped)
    : ip === "::" || ip === "::1" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
}

function isInternalV4(ip: string) {
  const [a = 0, b = 0] = ip.split(".").map(Number);

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** Holds an app's `app.fetch` to the rules; throws with what to fix, which the app's code sees. */
export async function checkFetch(
  rules: FetchRules,
  request: FetchRequest
): Promise<Checked> {
  const { app } = rules;
  let url: URL;

  try {
    url = new URL(request.url);
  } catch {
    throw new Error(`app.fetch: ${request.url} is not a URL.`);
  }

  if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443")) {
    throw new Error(
      `app.fetch reaches HTTPS on port 443 only, not ${url.origin}.`
    );
  }

  const host = url.hostname.toLowerCase();
  const connection = rules.connections.find((c) => c.host === host);

  if (!connection) {
    throw new Error(
      `The ${app} app does not list ${host} in its connections, so app.fetch refuses it.`
    );
  }

  const method = request.method.toUpperCase();

  const reads =
    method === "GET" ||
    method === "HEAD" ||
    (method === "POST" &&
      connection.query !== undefined &&
      url.pathname === connection.query);

  if (!reads) {
    throw new Error(
      `Apps only read: app.fetch takes GET and HEAD, and POST only to a connection's query path${connection.query ? ` (${connection.query} on ${host})` : ""}, not ${method} ${url.pathname}.`
    );
  }

  const { secret } = connection;

  if (secret !== undefined) {
    const hosts = rules.keyHosts(secret);

    if (!hosts) {
      throw new Error(`needs secret ${secret}: add it in Settings → Secrets.`);
    }

    if (!hosts.includes(host)) {
      throw new Error(
        `The ${secret} key is not for ${host}: it goes on requests to ${hosts.join(", ")}.`
      );
    }
  }

  const addresses = await (rules.resolve ?? resolveAll)(host);
  const [address] = addresses;

  if (address === undefined || addresses.some(isInternal)) {
    throw new Error(
      `${host} resolves to an address on the host's own network, which apps cannot reach.`
    );
  }

  return { url, secret, address };
}

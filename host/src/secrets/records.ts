// What the host keeps about the secrets beside the vault: the keys the imp asked for and the owner has not answered,
// and the latest uses of each secret. Names, hosts and times only; no value is ever written here.
//
//   DATA_DIR/secrets-requests.json   the open requests
//   DATA_DIR/secrets-uses.json       the newest 200 uses
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  arr,
  compile,
  int,
  obj,
  opt,
  str,
  type Validator,
} from "@earendil-works/pi-schema";
import type { EgressUse } from "./egress-proxy.ts";
import { readKept } from "../datadir/datadir.ts";

const USES_KEPT = 200;

/**
 * A key or login the imp asked the owner for, with everything but the value filled in: for "other", the hosts
 * (comma-separated), header, word before the key and variable; for a login, the site and, when the imp knows it, the
 * username. "" where it does not apply.
 */
export type KeyRequest = {
  readonly id: string;
  readonly name: string;
  readonly service: string;
  readonly why: string;
  readonly host: string;
  readonly header: string;
  readonly prefix: string;
  readonly envName: string;
  readonly username: string;
};

/** One use of a secret, and when the host recorded it. */
export type RecordedUse = EgressUse & {
  readonly id: string;
  readonly at: string;
};

// Requests written before the imp filled in the rest of the form lack the last four.
const requestsJson = compile(
  arr(
    obj({
      id: str(),
      name: str(),
      service: str(),
      why: str(),
      host: str(),
      header: opt(str()),
      prefix: opt(str()),
      envName: opt(str()),
      username: opt(str()),
    })
  )
);

const usesJson = compile(
  arr(
    obj({
      secret: str(),
      method: str(),
      host: str(),
      path: str(),
      status: int(),
      error: str(),
      app: opt(str()),
      id: str(),
      at: str(),
    })
  )
);

/** The list a file holds, which the host wrote; none when the file is missing or damaged. */
const readList = <T>(file: string, listed: Validator<T[]>): T[] =>
  readKept(file, listed, (problem) => {
    console.error(`secrets: ${problem}`);
  }) ?? [];

export function secretRecords(dataDir: string) {
  const usesFile = path.join(dataDir, "secrets-uses.json");
  const requestsFile = path.join(dataDir, "secrets-requests.json");
  let uses: readonly RecordedUse[] = readList(usesFile, usesJson);

  let requests: readonly KeyRequest[] = readList(
    requestsFile,
    requestsJson
  ).map((request) => ({
    ...request,
    header: request.header ?? "",
    prefix: request.prefix ?? "",
    envName: request.envName ?? "",
    username: request.username ?? "",
  }));

  const keepRequests = (next: readonly KeyRequest[]) => {
    requests = next;
    writeFileSync(requestsFile, JSON.stringify(requests), { mode: 0o600 });
  };

  return {
    /** Oldest first. */
    uses: () => uses,
    requests: () => requests,
    used: (use: EgressUse) => {
      uses = [
        ...uses,
        { ...use, id: randomUUID(), at: new Date().toISOString() },
      ].slice(-USES_KEPT);
      writeFileSync(usesFile, JSON.stringify(uses), { mode: 0o600 });
    },
    /** The imp asks for a key; a request for the same name replaces the earlier one. */
    ask: (request: Omit<KeyRequest, "id">) => {
      keepRequests([
        ...requests.filter((open) => open.name !== request.name),
        { id: randomUUID(), ...request },
      ]);
    },
    /** The owner added the key `name`. */
    answered: (name: string) => {
      keepRequests(requests.filter((open) => open.name !== name));
    },
    /** The owner turned request `id` down. */
    dismiss: (id: string) => {
      keepRequests(requests.filter((open) => open.id !== id));
    },
  };
}

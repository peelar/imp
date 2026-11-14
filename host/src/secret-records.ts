// What the host keeps about the secrets beside the vault: the keys the imp asked for and the owner has not answered,
// and the latest uses of each secret. Names, hosts and times only; no value is ever written here.
//
//   DATA_DIR/secrets-requests.json   the open requests
//   DATA_DIR/secrets-uses.json       the newest 200 uses
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  arr,
  compile,
  int,
  obj,
  str,
  type Validator,
} from "@earendil-works/pi-schema";
import type { EgressUse } from "./egress-proxy.ts";

const USES_KEPT = 200;

/** A key the imp asked the owner for. */
export type KeyRequest = {
  readonly id: string;
  readonly name: string;
  readonly service: string;
  readonly why: string;
  readonly host: string;
};

/** One use of a secret, and when the host recorded it. */
export type RecordedUse = EgressUse & {
  readonly id: string;
  readonly at: string;
};

const requestsJson = compile(
  arr(obj({ id: str(), name: str(), service: str(), why: str(), host: str() }))
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
      id: str(),
      at: str(),
    })
  )
);

/** The list a file holds, which the host wrote; none when the file is missing or holds something else. */
function readList<T>(file: string, listed: Validator<T[]>): T[] {
  try {
    const kept: unknown = existsSync(file)
      ? JSON.parse(readFileSync(file, "utf-8"))
      : [];

    return listed.check(kept) ? kept : [];
  } catch {
    return [];
  }
}

export type SecretRecords = ReturnType<typeof secretRecords>;

export function secretRecords(dataDir: string) {
  const usesFile = path.join(dataDir, "secrets-uses.json");
  const requestsFile = path.join(dataDir, "secrets-requests.json");
  let uses: readonly RecordedUse[] = readList(usesFile, usesJson);
  let requests: readonly KeyRequest[] = readList(requestsFile, requestsJson);

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

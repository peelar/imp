// What the owner chose in Settings for the agent's computer, and the E2B API key they entered there. Both are kept
// in the host's data directory, readable by the host alone.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  compile,
  lit,
  obj,
  opt,
  type Static,
  str,
  union,
} from "@earendil-works/pi-schema";
import { readKept } from "../kernel/kept.ts";

/** The cloud sizes, all within E2B's free plan (up to 8 vCPUs and 8 GiB). */
export const SIZES = [
  { id: "2c-4096m", label: "2 vCPUs, 4 GB", size: { cpus: 2, memoryMB: 4096 } },
  { id: "4c-8192m", label: "4 vCPUs, 8 GB", size: { cpus: 4, memoryMB: 8192 } },
  { id: "8c-8192m", label: "8 vCPUs, 8 GB", size: { cpus: 8, memoryMB: 8192 } },
] as const;

export const [DEFAULT_SIZE] = SIZES;

/** The size with this id; the smallest when there is none. */
export const sizeOf = (id: string) =>
  SIZES.find((size) => size.id === id) ?? DEFAULT_SIZE;

// Open objects: a later release may keep more about a choice than this one reads.
const choice = union([
  obj({ kind: lit("cloud"), size: str() }, { open: true }),
  obj(
    {
      kind: lit("own"),
      /** The computer's MagicDNS name on the tailnet. */
      device: str(),
      /** The agent's home directory there, as the first sign-in found it. */
      home: opt(str()),
    },
    { open: true }
  ),
]);

const stored = compile(choice);

/** Imp cloud (an E2B sandbox of a chosen size) or a computer of the owner's on the tailnet. */
export type Choice = Static<typeof choice>;

export type ChoiceStore = ReturnType<typeof openChoice>;

/** The choice a file holds; none when there is no file or it is damaged. */
const read = (file: string): Choice | undefined =>
  readKept(file, stored, (problem) => {
    console.error(`computer: ${problem} Choose a computer again in Settings.`);
  });

/** `environmentKey` is an E2B API key from the environment; one entered in Settings takes its place. */
export function openChoice(dataDir: string, environmentKey = "") {
  const file = path.join(dataDir, "computer.json");
  const keyFile = path.join(dataDir, "e2b-api-key");

  let cloudKey = existsSync(keyFile)
    ? readFileSync(keyFile, "utf-8").trim()
    : environmentKey;

  // A host that has a key and no choice yet starts on Imp cloud.
  const initial: Choice | undefined = cloudKey
    ? { kind: "cloud", size: DEFAULT_SIZE.id }
    : undefined;

  let current = read(file) ?? initial;

  return {
    get: () => current,
    set(next: Choice) {
      current = next;
      writeFileSync(file, JSON.stringify(next), { mode: 0o600 });
    },
    /** The E2B API key; "" when there is none. */
    cloudKey: () => cloudKey,
    setCloudKey(key: string) {
      cloudKey = key;
      writeFileSync(keyFile, key, { mode: 0o600 });
    },
  };
}

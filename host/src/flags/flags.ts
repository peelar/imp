// Feature flags: what lands for some hosts before every host. Each flag is declared here, off unless its default says
// otherwise, and the Flags SDK (`flags`) decides it once, as the host starts:
//
// 1. The owner's choice in DATA_DIR/flags.json, such as { "app-directory": true }: the local provider, which every host
//    has and which needs no network.
// 2. Else Vercel Flags (@flags-sdk/vercel), only when FLAGS holds a Vercel Flags SDK key. Without one, the adapter is
//    never loaded and deciding a flag reaches nothing outside the host.
// 3. Else the flag's default.
//
// A part of the host never decides a flag itself: the files that put the host together read the decisions and hand
// each part what a flag changes for it. Settings lists the flags and writes the owner's choice to flags.json
// (openFlags), which the next start decides by: a flag never changes while the host runs.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { bool, compile, map } from "@earendil-works/pi-schema";
import type { Adapter } from "flags";
import { flag } from "flags/next";
import { readKept } from "../datadir/datadir.ts";

/** Every feature flag: its key, what it turns on, and whether it is on for a host whose owner did not choose. */
const FLAGS = [
  {
    key: "app-directory",
    label: "App directory",
    description:
      "Apps others built, and any app on GitHub by its link, for your imp to install. It opens from the sidebar.",
    defaultValue: false,
  },
] as const;

export { flagCalls } from "./shell.ts";

/** The topic that changes when the owner chooses a flag. */
export const TOPIC = "flags";

export type FlagKey = (typeof FLAGS)[number]["key"];

/** The owner's choices: flags.json in the data directory, a flag's key to whether it is on. */
const chosenFile = compile(map(bool()));

export type FlagOptions = {
  readonly dataDir: string;
  /** A Vercel Flags SDK key; absent, the flags are decided on the host alone. */
  readonly sdkKey?: string | undefined;
  readonly log: (message: string) => void;
};

const chosenPath = (dataDir: string) => path.join(dataDir, "flags.json");

const readChosen = (options: FlagOptions) =>
  readKept(chosenPath(options.dataDir), chosenFile, options.log) ?? {};

/** A flag as Settings shows it: whether it is on now, and whether it will be on after the next start. */
export type FlagState = {
  readonly key: FlagKey;
  readonly label: string;
  readonly description: string;
  readonly on: boolean;
  readonly next: boolean;
};

/**
 * The flags, decided once as the host starts, with the owner's choice for the next start: `choose` writes it to
 * flags.json and says so on TOPIC through `changed`.
 */
export async function openFlags(
  options: FlagOptions & { readonly changed: () => void }
) {
  const on = await decideFlags(options);

  return {
    on,
    list: (): FlagState[] => {
      const chosen = readChosen(options);

      return FLAGS.map(({ key, label, description }) => ({
        key,
        label,
        description,
        on: on.has(key),
        next: chosen[key] ?? on.has(key),
      }));
    },
    choose(key: FlagKey, next: boolean) {
      writeFileSync(
        chosenPath(options.dataDir),
        JSON.stringify({ ...readChosen(options), [key]: next })
      );
      options.changed();
    },
  };
}

export type Flags = Awaited<ReturnType<typeof openFlags>>;

/** The flags that are on, decided once: the owner's choice, else Vercel Flags if the host has a key, else the default. */
async function decideFlags(
  options: FlagOptions
): Promise<ReadonlySet<FlagKey>> {
  const chosen = readChosen(options);

  const remote = options.sdkKey
    ? (await import("@flags-sdk/vercel")).createVercelAdapter(options.sdkKey)<
        boolean,
        undefined
      >()
    : undefined;

  const local: Adapter<boolean, undefined> = {
    decide: async (params) =>
      chosen[params.key] ??
      (remote ? await remote.decide(params) : params.defaultValue === true),
  };

  // Outside Next.js, flags/next decides for a request it is handed. The host decides for itself, so the request is
  // empty: no cookie overrides a flag.
  const request = new Request("http://localhost/");

  const decided = await Promise.all(
    FLAGS.map(async ({ key, description, defaultValue }) => {
      const on = await flag<boolean, undefined>({
        key,
        description,
        defaultValue,
        adapter: local,
      }).run({ identify: undefined, request });

      return { key, on };
    })
  );

  options.log(
    `flags: ${decided.map(({ key, on }) => `${key} ${on ? "on" : "off"}`).join(", ")}`
  );

  return new Set(decided.flatMap(({ key, on }) => (on ? [key] : [])));
}

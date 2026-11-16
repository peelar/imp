// Feature flags: what lands for some hosts before every host. Each flag is declared here, off unless its default says
// otherwise, and the Flags SDK (`flags`) decides it once, as the host starts:
//
// 1. The owner's choice in DATA_DIR/flags.json, such as { "github-app": true }: the local provider, which every host
//    has and which needs no network.
// 2. Else Vercel Flags (@flags-sdk/vercel), only when FLAGS holds a Vercel Flags SDK key. Without one, the adapter is
//    never loaded and deciding a flag reaches nothing outside the host.
// 3. Else the flag's default.
//
// A part of the host never decides a flag itself: the files that put the host together read the decisions and hand
// each part what a flag changes for it, such as the apps the gateway keeps off.
import path from "node:path";
import { bool, compile, map } from "@earendil-works/pi-schema";
import type { Adapter } from "flags";
import { flag } from "flags/next";
import { readKept } from "../kernel/kept.ts";

/** Every feature flag: its key, what it turns on, and whether it is on for a host whose owner did not choose. */
export const FLAGS = [
  {
    key: "github-app",
    description:
      "The GitHub app (client/apps/github): its tab, its sync, and the imp's use of it.",
    defaultValue: false,
  },
] as const;

export type FlagKey = (typeof FLAGS)[number]["key"];

/** The owner's choices: flags.json in the data directory, a flag's key to whether it is on. */
const chosenFile = compile(map(bool()));

export type FlagOptions = {
  readonly dataDir: string;
  /** A Vercel Flags SDK key; absent, the flags are decided on the host alone. */
  readonly sdkKey?: string | undefined;
  readonly log: (message: string) => void;
};

/** The flags that are on, decided once: the owner's choice, else Vercel Flags if the host has a key, else the default. */
export async function decideFlags(
  options: FlagOptions
): Promise<ReadonlySet<FlagKey>> {
  const chosen =
    readKept(
      path.join(options.dataDir, "flags.json"),
      chosenFile,
      options.log
    ) ?? {};

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

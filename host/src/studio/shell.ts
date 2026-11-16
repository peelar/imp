// The person's side of making apps: the apps and their drafts as the shell lists them, which build of the shell the
// host serves, the person's decisions on a draft: Save, Discard and Undo, and installing and uninstalling an app. Only
// the person makes them; the agent only previews (tools.ts).
import { SYNC_TOPIC } from "../apps/apps.ts";
import {
  type Call,
  type Calls,
  type LiveSource,
  ok,
  refused,
  text,
  why,
} from "../live/live.ts";
import type { Studio } from "./studio.ts";

/** What the open views listen on for a change of the apps' list or drafts, and of the build the host serves. */
export const APPS_TOPIC = "apps";
export const BUILD_TOPIC = "build";

/** The apps, each one's draft and its sync, as the shell's tabs and directory show them. */
export const appsSource = (studio: Studio): LiveSource => ({
  topics: [APPS_TOPIC, SYNC_TOPIC],
  load: async () => studio.state(),
});

/** The build of the shell the host serves now, so an open page reloads into a new one. */
export const buildSource = (studio: Studio): LiveSource => ({
  topics: [BUILD_TOPIC],
  load: async () => ({ id: studio.buildId() }),
});

/** The person's decisions on an app's draft and its saved versions; a decision that cannot be made says why. */
export function studioCalls(studio: Studio): Calls {
  const decision =
    (decide: (id: string) => Promise<void>): Call =>
    async (args) => {
      try {
        await decide(text(args, 0));

        return ok;
      } catch (error) {
        return refused(why(error));
      }
    };

  return [
    [
      "appsSave",
      decision(async (id) => {
        await studio.save(id);
      }),
    ],
    [
      "appsDiscard",
      decision(async (id) => {
        await studio.discard(id);
      }),
    ],
    [
      "appsUndo",
      decision(async (id) => {
        await studio.undo(id);
      }),
    ],
    [
      "appsInstall",
      decision(async (id) => {
        await studio.install(id);
      }),
    ],
    [
      "appsUninstall",
      decision(async (id) => {
        await studio.uninstall(id);
      }),
    ],
  ];
}

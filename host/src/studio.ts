// Where apps are made. The agent writes an app's folder in its own workspace and asks for a preview; the studio
// takes the folder from the machine (nothing else crosses over), tries its server code on a copy of the data, builds
// the shell with its screen, and only then makes it the app's draft, which the shell shows in the app's tab with Save
// and Discard. Only the person saves: Save makes the draft live and keeps the version before it, which Undo restores
// for 48 hours.
//
// This module puts the studio together and gives the host its handle on it. The parts:
//   studio-workspace.ts   an app's folder between the agent's workspace and the host
//   studio-preview.ts     the agent's preview: check the workspace's version and make it the draft
//   studio-decisions.ts   the person's Save, Discard and Undo
//   studio-tools.ts       the agent's tools and its prompt section
//   studio-code.ts        the code the host keeps: code/<id>/live/ and code/<id>/draft/ under DATA_DIR
//   studio-history.ts     the versions a save replaced: code/<id>/history/<ms>/
//   studio-builds.ts      the web builds of the shell, builds/<build id>/, and the one the host serves
import type { Context } from "@earendil-works/chord/context";
import type { Registry } from "@earendil-works/pi-durable";
import type { RemoteExecutionEnv } from "@earendil-works/pi-env";
import { type AppInfo, draftSlot } from "./app-folders.ts";
import type { AppGateway } from "./apps.ts";
import type { Topics } from "./live.ts";
import { shellBuilds } from "./studio-builds.ts";
import { codeFolders } from "./studio-code.ts";
import { appDecisions } from "./studio-decisions.ts";
import { versionHistory } from "./studio-history.ts";
import { appPreview } from "./studio-preview.ts";
import { studioTools } from "./studio-tools.ts";
import { agentWorkspace } from "./studio-workspace.ts";

export { storedApps } from "./studio-code.ts";

export const APPS_TOPIC = "apps";
export const BUILD_TOPIC = "build";

export type StudioOptions = {
  readonly dataDir: string;
  /** The repository's apps (client/apps). */
  readonly repoAppsDir: string;
  /** The shell's source (client/). */
  readonly clientDir: string;
  /** The Exact checkout the shell builds with. */
  readonly exact: string;
  readonly gateway: AppGateway;
  readonly topics: Topics;
  readonly registry: Registry;
  /** The agent's files, and where it works on them: the current computer's, which the owner may switch. */
  readonly files: () => RemoteExecutionEnv;
  readonly workspace: () => string;
  readonly context: Context;
  readonly drafts: readonly AppInfo[];
  readonly log?: ((message: string) => void) | undefined;
};

/** One change at a time: previews, saves, discards and undos each build the shell and swap versions. */
function oneAtATime() {
  let queue: Promise<unknown> = Promise.resolve();

  return async <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work);

    // Whoever asked for the work hears how it went; the next in line only waits for it to end.
    queue = Promise.allSettled([run]);

    return await run;
  };
}

export function studio(options: StudioOptions) {
  const { gateway, topics } = options;

  const log =
    options.log ??
    ((message) => {
      console.log(message);
    });

  const appsChanged = () => {
    topics.changed(APPS_TOPIC);
  };

  const folders = codeFolders(options.dataDir);
  const history = versionHistory({ folders, data: gateway.data });

  const builds = shellBuilds({
    dataDir: options.dataDir,
    clientDir: options.clientDir,
    exact: options.exact,
    gateway,
    served() {
      topics.changed(BUILD_TOPIC);
    },
    log,
  });

  const workspace = agentWorkspace({
    files: options.files,
    workspace: options.workspace,
    exact: options.exact,
    context: options.context,
  });

  const preview = appPreview({
    dataDir: options.dataDir,
    gateway,
    workspace,
    folders,
    builds,
    appsChanged,
  });

  const decisions = appDecisions({
    gateway,
    folders,
    history,
    builds,
    appsChanged,
  });

  const serial = oneAtATime();

  options.registry.install(
    studioTools({
      gateway,
      workspace,
      workspaceDir: options.workspace,
      preview: async (id) => await serial(async () => await preview(id)),
    })
  );

  return {
    /** The apps for the shell, with each one's draft and undo. */
    state: () =>
      gateway.apps().map((app) => ({
        ...app,
        draft: gateway.version(draftSlot(app.id)) !== undefined,
        undo: decisions.undoKind(app.id),
      })),
    /** The build the host serves, "repo" while it serves the repository's own. */
    buildId: () => builds.current() ?? "repo",
    /** Where that build is, undefined for the repository's. */
    clientDir: () => builds.dir(),
    save: async (id: string) => {
      await serial(async () => {
        await decisions.save(id);
      });
    },
    discard: async (id: string) => {
      await serial(async () => {
        await decisions.discard(id);
      });
    },
    undo: async (id: string) => {
      await serial(async () => {
        await decisions.undo(id);
      });
    },
    /** Starts the drafts, and rebuilds the shell when the host holds apps the repository's build lacks. */
    async start() {
      await Promise.all(
        options.drafts.map(async (app) => {
          try {
            await gateway.install(draftSlot(app.id), app);
          } catch (error) {
            log(`studio: draft ${app.id}: ${String(error)}`);
          }
        })
      );

      if (folders.any()) {
        await serial(builds.rebuild);
      }
    },
  };
}

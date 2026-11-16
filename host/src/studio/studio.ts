// Where apps are made. The agent writes an app's folder in its own workspace and asks for a preview; the studio
// takes the folder from the machine (nothing else crosses over), tries its server code on a copy of the data, builds
// the shell with its screen, and only then makes it the app's draft, which the shell shows in the app's tab with Save
// and Discard. Only the person saves: Save makes the draft live and keeps the version before it, which Undo restores
// for 48 hours.
//
// This module puts the studio together and gives the host its handle on it. The parts:
//   workspace.ts   an app's folder between the agent's workspace and the host
//   preview.ts     the agent's preview: check the workspace's version and make it the draft
//   decisions.ts   the person's Save, Discard and Undo
//   installs.ts    the person's Install and Uninstall
//   tools.ts       the agent's tools and its prompt section
//   code.ts        the code the host keeps: code/<id>/live/ and code/<id>/draft/ under DATA_DIR
//   history.ts     the versions a save replaced: code/<id>/history/<ms>/
//   builds.ts      the web builds of the shell, builds/<build id>/, and the one the host serves
//   toolchain.ts   the Exact they build with, which an installed host installs itself
import type { Context } from "@earendil-works/chord/context";
import type { Registry } from "@earendil-works/pi-durable";
import type { RemoteExecutionEnv } from "@earendil-works/pi-env";
import type { AppInfo, AppGateway } from "../apps/apps.ts";
import type { Topics } from "../live/live.ts";
import { shellBuilds } from "./builds.ts";
import { codeFolders, impServers, shippedApps } from "./code.ts";
import { appDecisions } from "./decisions.ts";
import { appInstalls } from "./installs.ts";
import { versionHistory } from "./history.ts";
import { appPreview } from "./preview.ts";
import { APPS_TOPIC, BUILD_TOPIC } from "./shell.ts";
import { exactToolchain } from "./toolchain.ts";
import { studioTools } from "./tools.ts";
import { agentWorkspace } from "./workspace.ts";

export { storedApps } from "./code.ts";

export {
  APPS_TOPIC,
  appsSource,
  BUILD_TOPIC,
  buildSource,
  studioCalls,
} from "./shell.ts";

export type StudioOptions = {
  readonly dataDir: string;
  /** The repository's apps (client/apps). */
  readonly repoAppsDir: string;
  /** The shell's source (client/). */
  readonly clientDir: string;
  /** The Exact checkout the shell builds with. */
  readonly exact: string;
  /** scripts/setup.sh, on a host that installs Exact itself (toolchain.ts). Absent: a checkout's developer does. */
  readonly exactSetup?: string | undefined;
  readonly gateway: AppGateway;
  readonly topics: Topics;
  readonly registry: Registry;
  /** The agent's files, and where it works on them: the current computer's, which the owner may switch. */
  readonly files: () => RemoteExecutionEnv;
  readonly workspace: () => string;
  readonly context: Context;
  readonly drafts: readonly AppInfo[];
  /** A save or an undo changed an app's live code, said in words such as "Save Todos" (the backup commits it). */
  readonly liveChanged: (what: string) => void;
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

export type Studio = ReturnType<typeof studio>;

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
  const imp = impServers(options.repoAppsDir);
  const shipped = shippedApps(options.repoAppsDir);
  const history = versionHistory({ folders, data: gateway });

  const toolchain = exactToolchain({
    dataDir: options.dataDir,
    clientDir: options.clientDir,
    exact: options.exact,
    setup: options.exactSetup,
    log,
  });

  const builds = shellBuilds({
    dataDir: options.dataDir,
    clientDir: options.clientDir,
    exact: options.exact,
    toolchain,
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

  // What a preview and a decision both change: the code, the shell's build and the apps the shell lists.
  const versions = { gateway, folders, builds, imp, appsChanged };
  const preview = appPreview({ ...versions, workspace });
  const decisions = appDecisions({ ...versions, history });
  const installs = appInstalls({ ...versions, shipped });

  const serial = oneAtATime();

  const nameOf = (id: string) =>
    gateway.apps().find((app) => app.id === id)?.name;

  /**
   * A decision of the person's, one change at a time. One that changes the live code says so in words, such as
   * "Save Todos", for the backup to commit: the app's name from before, as an undo or an uninstall removes the app.
   */
  const decide =
    (work: (id: string) => Promise<void>, said?: (name: string) => string) =>
    async (id: string) => {
      const before = nameOf(id);

      await serial(async () => {
        await work(id);
      });

      if (said) {
        options.liveChanged(said(before ?? nameOf(id) ?? id));
      }
    };

  options.registry.install(
    studioTools({
      gateway,
      workspace,
      workspaceDir: options.workspace,
      shipped,
      preview: async (id) => await serial(async () => await preview(id)),
    })
  );

  return {
    /** The apps for the shell, with each one's draft and undo, what it reads and how its sync went. */
    state: () =>
      gateway.apps().map((app) => ({
        ...app,
        draft: gateway.draft(app.id) !== undefined,
        undo: decisions.undoKind(app.id),
        reads: gateway.reads(app.id),
        sync: gateway.syncLine(app.id),
      })),
    /** Whether the onboarding still shows the person their first app: the host never had an app. */
    introduceApps: () => !folders.any(),
    /** The build the host serves, "repo" while it serves the repository's own. */
    buildId: () => builds.current() ?? "repo",
    /** Where that build is, undefined for the repository's. */
    clientDir: () => builds.dir(),
    save: decide(decisions.save, (name) => `Save ${name}`),
    discard: decide(decisions.discard),
    undo: decide(decisions.undo, (name) => `Undo the last save of ${name}`),
    install: decide(installs.install, (name) => `Install ${name}`),
    uninstall: decide(installs.uninstall, (name) => `Uninstall ${name}`),
    /** Starts the drafts, and rebuilds the shell when the host holds apps the repository's build lacks. */
    async start() {
      // Exact installs while the drafts start, so the first preview need not wait for it.
      const tools = toolchain.ready();

      await Promise.all(
        options.drafts.map(async (app) => {
          try {
            await gateway.stage(app, { keepData: true });
          } catch (error) {
            log(`studio: draft ${app.id}: ${String(error)}`);
          }
        })
      );

      await tools;

      if (folders.any()) {
        await serial(builds.rebuild);
      }
    },
  };
}

// The agent's side of making an app: a preview. The studio takes the app's folder from the agent's workspace, tries
// its server code on a copy of the data, builds the shell with its screen, and only then makes it the app's draft,
// which the shell shows in the app's tab with Save and Discard.
import {
  type AppFiles,
  appInfo,
  type AppGateway,
  type Which,
  type Manifest,
} from "../apps/apps.ts";
import type { ShellBuilds } from "./builds.ts";
import type { CodeFolders, ImpServers } from "./code.ts";
import { type AgentWorkspace, requireAppId } from "./workspace.ts";

export type PreviewOptions = {
  readonly gateway: AppGateway;
  readonly workspace: AgentWorkspace;
  readonly folders: CodeFolders;
  readonly builds: ShellBuilds;
  /** The apps whose server code is Imp's (code.ts). */
  readonly imp: ImpServers;
  /** Tells the open shells that the apps changed. */
  readonly appsChanged: () => void;
  /** Hears of the new draft before the shells are told to load it. */
  readonly previewed: (id: string) => Promise<void>;
};

/**
 * Throws, for an app whose server code is Imp's, when a version changes it: its server.ts and app.json come with Imp,
 * and only its screen is the person's.
 */
export function requireImpServer(files: AppFiles, imp: AppFiles | undefined) {
  const changed = imp
    ? (["server.ts", "app.json"] as const).filter(
        (name) => files[name] !== imp[name]
      )
    : [];

  if (changed.length > 0) {
    throw new Error(
      `This app's server.ts and app.json come with Imp, and Imp's updates replace them, so only its screen (app.contract) is the user's to change. Put back ${changed.join(" and ")} as app_code wrote them. If the screen needs data the app does not give, tell the user what is missing.`
    );
  }
}

/** Whether data that had the migrations `had` reaches `schema` by adding migrations: none of its own changed. */
const leadsTo = (had: readonly string[], schema: readonly string[]) =>
  had.every((sql, i) => schema[i] === sql);

export function appPreview(options: PreviewOptions) {
  const { gateway, workspace, folders, builds } = options;

  /** The manifest of one of the app's versions; none when it has none or it does not load. */
  const manifestOf = async (
    id: string,
    which: Which
  ): Promise<Manifest | undefined> => {
    if (!(which === "draft" ? gateway.draft(id) : gateway.live(id))) {
      return undefined;
    }

    try {
      return await gateway.manifest(id, which);
    } catch {
      return undefined;
    }
  };

  /** Migrations are kept in order and never changed once the user's data has had them. */
  const requireSavedMigrations = async (id: string, manifest: Manifest) => {
    const saved = await manifestOf(id, "live");

    const changed =
      saved?.schema.findIndex((sql, i) => manifest.schema[i] !== sql) ?? -1;

    if (saved && changed >= 0) {
      throw new Error(
        `Migration ${changed + 1} in server.ts differs from the one the user's data already has (${JSON.stringify(saved.schema[changed])}). Keep the saved migrations as they are and add a new one at the end.`
      );
    }
  };

  /**
   * The version's manifest, from its server code on a copy of the data the draft will run on: the draft's own while
   * its migrations still lead to the new ones, so test entries survive a change that keeps the data's structure; else
   * the live data.
   */
  const check = async (app: ReturnType<typeof appInfo>) => {
    const previous = await manifestOf(app.id, "draft");
    const manifest = await gateway.trial(app, "live");

    await requireSavedMigrations(app.id, manifest);

    return previous !== undefined && leadsTo(previous.schema, manifest.schema)
      ? { manifest: await gateway.trial(app, "draft"), keepDraftData: true }
      : { manifest, keepDraftData: false };
  };

  /** Checks the workspace's version of an app and makes it the app's draft, shown in its tab. */
  return async function preview(id: string) {
    requireAppId(id);

    const files = await workspace.read(id);

    requireImpServer(files, options.imp.get(id));

    const app = appInfo(files, id);
    const { manifest, keepDraftData } = await check(app);

    // The shell, with this version's screen.
    const built = await builds.build(
      await builds.shown({
        id,
        files: app.files,
        operations: manifest.operations,
      })
    );

    // All good: this is the draft now.
    folders.put(id, "draft", app.files);
    await gateway.stage(app, { keepData: keepDraftData });
    await options.previewed(id);
    builds.serve(built);
    options.appsChanged();

    const data = gateway.live(id)
      ? "a copy of the user's data"
      : "empty data (the app is new)";

    return `The preview is ready: the user sees ${app.name} in its tab, on ${data}, with Save and Discard. Tell them what to try; only they can save.`;
  };
}

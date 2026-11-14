// The agent's side of making an app: a preview. The studio takes the app's folder from the agent's workspace, tries
// its server code on a copy of the data, builds the shell with its screen, and only then makes it the app's draft,
// which the shell shows in the app's tab with Save and Discard.
import { rmSync } from "node:fs";
import path from "node:path";
import { type AppInfo, appInfo, checkSlot, draftSlot } from "./app-folders.ts";
import type { AppGateway } from "./apps.ts";
import type { Manifest } from "./protocol.ts";
import type { ShellBuilds } from "./studio-builds.ts";
import type { CodeFolders } from "./studio-code.ts";
import { type AgentWorkspace, requireAppId } from "./studio-workspace.ts";

export type PreviewOptions = {
  readonly dataDir: string;
  readonly gateway: AppGateway;
  readonly workspace: AgentWorkspace;
  readonly folders: CodeFolders;
  readonly builds: ShellBuilds;
  /** Tells the open shells that the apps changed. */
  readonly appsChanged: () => void;
};

/** Whether data that had the migrations `had` reaches `schema` by adding migrations: none of its own changed. */
const leadsTo = (had: readonly string[], schema: readonly string[]) =>
  had.every((sql, i) => schema[i] === sql);

export function appPreview(options: PreviewOptions) {
  const { gateway, workspace, folders, builds } = options;

  /** The manifest of the version in a slot; none when the slot is empty or its version does not load. */
  const manifestIn = async (slot: string): Promise<Manifest | undefined> => {
    if (!gateway.version(slot)) {
      return undefined;
    }

    try {
      return await gateway.manifest(slot);
    } catch {
      return undefined;
    }
  };

  /** Fills a slot nothing runs in with a copy of another slot's data. */
  const copyData = (from: string, to: string) => {
    const scratch = path.join(options.dataDir, "apps", `${to}.copy`);

    gateway.data.copyTo(from, scratch);
    gateway.data.replace(to, scratch);
    rmSync(scratch, { force: true });
  };

  /** Tries the version's server code on a copy of a slot's data; answers its manifest, or throws why it failed. */
  const tryOn = async (app: AppInfo, slot: string) => {
    const check = checkSlot(app.id);

    gateway.uninstall(check);
    copyData(slot, check);

    try {
      return await gateway.install(check, app);
    } finally {
      gateway.uninstall(check);
      gateway.data.remove(check);
    }
  };

  /** Migrations are kept in order and never changed once the user's data has had them. */
  const requireSavedMigrations = async (id: string, manifest: Manifest) => {
    const saved = await manifestIn(id);

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
  const check = async (app: AppInfo) => {
    const draft = draftSlot(app.id);
    const previous = await manifestIn(draft);
    const manifest = await tryOn(app, app.id);

    await requireSavedMigrations(app.id, manifest);

    return previous !== undefined && leadsTo(previous.schema, manifest.schema)
      ? { manifest: await tryOn(app, draft), keepDraftData: true }
      : { manifest, keepDraftData: false };
  };

  /** Checks the workspace's version of an app and makes it the app's draft, shown in its tab. */
  return async function preview(id: string) {
    requireAppId(id);

    const app = appInfo(await workspace.read(id), id);
    const draft = draftSlot(id);
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
    if (!keepDraftData) {
      gateway.uninstall(draft);
      copyData(id, draft);
    }

    folders.put(id, "draft", app.files);
    await gateway.install(draft, app);
    builds.serve(built);
    options.appsChanged();

    const data = gateway.version(id)
      ? "a copy of the user's data"
      : "empty data (the app is new)";

    return `The preview is ready: the user sees ${app.name} in its tab, on ${data}, with Save and Discard. Tell them what to try; only they can save.`;
  };
}

// The person's side of making an app: only they save. Save makes the draft live and keeps the version before it,
// Discard drops the draft, and Undo restores the version the last save replaced.
import { appInfo, draftSlot, readAppFiles } from "./app-folders.ts";
import type { AppGateway } from "./apps.ts";
import type { ShellBuilds } from "./studio-builds.ts";
import type { CodeFolders } from "./studio-code.ts";
import type { VersionHistory } from "./studio-history.ts";

export type DecisionsOptions = {
  readonly gateway: AppGateway;
  readonly folders: CodeFolders;
  readonly history: VersionHistory;
  readonly builds: ShellBuilds;
  /** Tells the open shells that the apps changed. */
  readonly appsChanged: () => void;
};

export function appDecisions(options: DecisionsOptions) {
  const { gateway, folders, history, builds } = options;

  const dropDraft = (id: string) => {
    gateway.uninstall(draftSlot(id));
    gateway.data.remove(draftSlot(id));
    folders.drop(id, "draft");
  };

  /** Makes the app's draft its live version, keeping the version before it for Undo. */
  async function save(id: string) {
    const draft = gateway.version(draftSlot(id));

    if (!draft) {
      throw new Error(`The ${id} app has no preview to save.`);
    }

    const live = gateway.version(id);
    const entry = history.keep(id, live?.files);

    try {
      // The live data takes the draft's migrations as this version loads.
      await gateway.install(id, draft);
    } catch (error) {
      gateway.uninstall(id);

      if (live) {
        gateway.data.replace(id, entry.data);

        try {
          await gateway.install(id, live);
        } catch {
          // The version from before does not start either: the person hears why the save failed, not this.
        }
      } else {
        gateway.data.remove(id);
      }

      history.forget(entry);
      throw error;
    }

    folders.put(id, "live", draft.files);
    dropDraft(id);
    history.prune(id);
    // The shell already shows this version's screen; only its bar changes.
    options.appsChanged();
  }

  async function discard(id: string) {
    if (!gateway.version(draftSlot(id))) {
      throw new Error(`The ${id} app has no preview to discard.`);
    }

    dropDraft(id);
    options.appsChanged();
    await builds.rebuild();
  }

  async function undo(id: string) {
    if (gateway.version(draftSlot(id))) {
      throw new Error("Save or discard the preview first.");
    }

    const entry = history.latest(id);

    if (!entry) {
      throw new Error(`The ${id} app has no save to undo.`);
    }

    // The data goes back too, unless it has had no migration since: then what the person entered since stays.
    const restoreData =
      entry.code === undefined ||
      entry.schema !== gateway.data.schemaVersion(id);

    gateway.uninstall(id);

    if (entry.code === undefined) {
      // The save made the app: undoing it removes the app, with the rest of its folder.
      gateway.data.remove(id);
      folders.remove(id);
    } else {
      const previous = appInfo(readAppFiles(entry.code), id);

      if (restoreData) {
        gateway.data.replace(id, entry.data);
      }

      folders.put(id, "live", previous.files);
      await gateway.install(id, previous);
      history.forget(entry);
    }

    options.appsChanged();
    await builds.rebuild();
  }

  return {
    save,
    discard,
    undo,
    /** What undoing the app's last save does, for the shell's button: see AppTile in client/app.contract. */
    undoKind(id: string) {
      if (gateway.version(draftSlot(id))) {
        return "";
      }

      const entry = history.latest(id);

      if (!entry) {
        return "";
      }

      if (entry.code === undefined) {
        return "remove";
      }

      return entry.schema === gateway.data.schemaVersion(id) ? "keep" : "data";
    },
  };
}

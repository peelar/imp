// The person's side of making an app: only they save. Save makes the draft live and keeps the version before it,
// Discard drops the draft, and Undo restores the version the last save replaced.
import { appInfo, readAppFiles, type AppGateway } from "../apps/apps.ts";
import { type CodeFolders, type ImpServers, withImpServer } from "./code.ts";
import type { VersionHistory } from "./history.ts";

export type DecisionsOptions = {
  readonly gateway: AppGateway;
  readonly folders: CodeFolders;
  readonly history: VersionHistory;
  /** The apps whose server code is Imp's (code.ts): Undo brings back their screen, with Imp's server code. */
  readonly imp: ImpServers;
  /** Tells the open shells that the apps changed. */
  readonly appsChanged: () => void;
  /**
   * Rebuilds the served build after the work under way, without waiting for it: a build can outlast a caller that
   * gives up on a slow answer (the Mac app's after 60 s), and open pages relaunch once the new build is served.
   */
  readonly rebuildLater: () => void;
};

export function appDecisions(options: DecisionsOptions) {
  const { gateway, folders, history } = options;

  const dropDraft = (id: string) => {
    gateway.dropDraft(id);
    folders.drop(id, "draft");
  };

  /** Makes the app's draft its live version, keeping the version before it for Undo. */
  async function save(id: string) {
    const draft = gateway.draft(id);

    if (!draft) {
      throw new Error(`The ${id} app has no preview to save.`);
    }

    const entry = history.keep(id, gateway.live(id)?.files);

    try {
      await gateway.promote(id, entry.data);
    } catch (error) {
      history.forget(entry);
      throw error;
    }

    folders.put(id, "live", draft.files);
    folders.drop(id, "draft");
    history.prune(id);
    // The shell already shows this version's screen; only its bar changes.
    options.appsChanged();
  }

  async function discard(id: string) {
    if (!gateway.draft(id)) {
      throw new Error(`The ${id} app has no preview to discard.`);
    }

    dropDraft(id);
    options.appsChanged();
    options.rebuildLater();
  }

  async function undo(id: string) {
    if (gateway.draft(id)) {
      throw new Error("Save or discard the preview first.");
    }

    const entry = history.latest(id);

    if (!entry) {
      throw new Error(`The ${id} app has no save to undo.`);
    }

    // The data goes back too, unless it has had no migration since: then what the person entered since stays.
    const restoreData =
      entry.code === undefined || entry.schema !== gateway.schemaVersion(id);

    if (entry.code === undefined) {
      // The save made the app: undoing it removes the app, with the rest of its folder.
      await gateway.restore(id, undefined);
      folders.remove(id);
    } else {
      const previous = appInfo(
        withImpServer(readAppFiles(entry.code), options.imp.get(id)),
        id
      );

      folders.put(id, "live", previous.files);
      await gateway.restore(id, {
        app: previous,
        data: restoreData ? entry.data : undefined,
      });
      history.forget(entry);
    }

    options.appsChanged();
    options.rebuildLater();
  }

  return {
    save,
    discard,
    undo,
    /** What undoing the app's last save does, for the shell's button: see AppTile in client/app.contract. */
    undoKind(id: string) {
      if (gateway.draft(id)) {
        return "";
      }

      let entry: ReturnType<typeof history.latest>;

      try {
        entry = history.latest(id);
      } catch {
        // A damaged history entry offers no Undo here; pressing Undo anyway would say what is wrong with it.
        return "";
      }

      if (!entry) {
        return "";
      }

      if (entry.code === undefined) {
        return "remove";
      }

      return entry.schema === gateway.schemaVersion(id) ? "keep" : "data";
    },
  };
}

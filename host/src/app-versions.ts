// An app's versions, as the studio moves them: the live one, a draft beside it on a copy of the live data, and a
// version tried on a copy before it becomes the draft. The gateway owns the slots each version runs in and the data
// each slot has, so the studio says what should happen to an app and this file does it, never replacing a slot's data
// while the slot runs.
import { rmSync } from "node:fs";
import path from "node:path";
import type { AppData } from "./app-data.ts";
import { type AppInfo, checkSlot, draftSlot } from "./app-folders.ts";
import type { AppMachine } from "./app-machine.ts";
import type { Manifest } from "./protocol.ts";

/** Which of an app's versions: the one the agent and the person use, or the preview beside it. */
export type Which = "live" | "draft";

/** A version to go back to: its code, and a copy of its data (absent: the data stays as it is). */
export type Previous = {
  readonly app: AppInfo;
  readonly data?: string | undefined;
};

export type VersionsOptions = {
  readonly machine: AppMachine;
  readonly data: AppData;
  /** Where a copy of the data is made before it fills a slot. */
  readonly scratchDir: string;
  readonly install: (slot: string, app: AppInfo) => Promise<Manifest>;
  readonly uninstall: (slot: string) => void;
};

export function appVersions(options: VersionsOptions) {
  const { machine, data, install, uninstall } = options;
  const slots = machine.slots();

  const slotOf = (id: string, which: Which) =>
    which === "draft" ? draftSlot(id) : id;

  /** Fills a slot nothing runs in with a copy of another slot's data. */
  const copyData = (from: string, to: string) => {
    const scratch = path.join(options.scratchDir, `${to}.copy`);

    data.copyTo(from, scratch);
    data.replace(to, scratch);
    rmSync(scratch, { force: true });
  };

  const dropDraft = (id: string) => {
    uninstall(draftSlot(id));
    data.remove(draftSlot(id));
  };

  return {
    live: (id: string) => slots.get(id),
    draft: (id: string) => slots.get(draftSlot(id)),
    /** The manifest of one of the app's versions, once it loaded. */
    manifest: async (id: string, which: Which) =>
      (await machine.loaded(slotOf(id, which))).manifest,
    /** Tries a version on a copy of the live or the draft data; answers its manifest, or throws why it failed. */
    async trial(app: AppInfo, on: Which) {
      const check = checkSlot(app.id);

      uninstall(check);
      copyData(slotOf(app.id, on), check);

      try {
        return await install(check, app);
      } finally {
        uninstall(check);
        data.remove(check);
      }
    },
    /** Runs a version as the app's draft: on a fresh copy of the live data, or on the data the draft has. */
    async stage(app: AppInfo, { keepData }: { readonly keepData: boolean }) {
      const draft = draftSlot(app.id);

      if (!keepData) {
        uninstall(draft);
        copyData(app.id, draft);
      }

      await install(draft, app);
    },
    dropDraft,
    /** Copies the live data to a file, such as before a save replaces the version that wrote it. */
    snapshot: (id: string, file: string) => {
      data.copyTo(id, file);
    },
    /** How many migrations the live data has had. */
    schemaVersion: (id: string) => data.schemaVersion(id),
    /**
     * Makes the draft live; the live data takes its migrations as it loads. When it does not start, the version before
     * it runs again on `before`, the copy of the live data taken first, and the error is thrown.
     */
    async promote(id: string, before: string) {
      const draft = slots.get(draftSlot(id));
      const live = slots.get(id);

      if (!draft) {
        throw new Error(`The ${id} app has no preview to save.`);
      }

      try {
        await install(id, draft);
      } catch (error) {
        uninstall(id);

        if (live) {
          data.replace(id, before);

          try {
            await install(id, live);
          } catch {
            // The version from before does not start either: the person hears why the save failed, not this.
          }
        } else {
          data.remove(id);
        }

        throw error;
      }

      dropDraft(id);
    },
    /** Runs an earlier version as the live one again; none removes the app and its data. */
    async restore(id: string, previous: Previous | undefined) {
      uninstall(id);

      if (!previous) {
        data.remove(id);

        return;
      }

      if (previous.data !== undefined) {
        data.replace(id, previous.data);
      }

      await install(id, previous.app);
    },
  };
}

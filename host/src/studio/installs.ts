// The person's Install and Uninstall, apart from the decisions on a draft (decisions.ts). Install puts in an app Imp
// ships, as the onboarding does with GitHub and the app directory with Todos; Uninstall removes any app with its data.
import { setTimeout } from "node:timers/promises";
import {
  APP_ID,
  type AppFiles,
  appInfo,
  type AppGateway,
} from "../apps/apps.ts";
import type { ShellBuilds } from "./builds.ts";
import type { CodeFolders } from "./code.ts";

export type InstallsOptions = {
  readonly gateway: AppGateway;
  readonly folders: CodeFolders;
  readonly builds: ShellBuilds;
  /** The repository's apps, which the person can install as Imp ships them. */
  readonly shipped: ReadonlyMap<string, AppFiles>;
  /** Tells the open shells that the apps changed. */
  readonly appsChanged: () => void;
  /** Rebuilds the served build after the work under way, without waiting for it. */
  readonly rebuildLater: () => void;
  readonly log: (message: string) => void;
};

/** How long Install waits for the app to load before it answers anyway. */
const INSTALL_WAIT_MS = 5000;

export function appInstalls(options: InstallsOptions) {
  const { gateway, folders, builds } = options;

  return {
    /**
     * Installs an app Imp ships, and answers once it is in, or within a few seconds of starting to load: loading waits
     * for the computer, and a container or cloud machine that was asleep can take a minute to start, longer than a
     * caller waits (the Mac app gives up after 60 s, and the onboarding then never moves on). An app that fails to load
     * later is removed again, as one that fails at once is, and the shell hears so. The served build is rebuilt only
     * when it is the host's (the repository's has every one), after the answer: on a new host it installs Exact first.
     */
    install: async (id: string) => {
      const files = options.shipped.get(id);

      if (!files) {
        throw new Error(`Imp ships no app named ${id}.`);
      }

      if (gateway.live(id) || gateway.draft(id)) {
        throw new Error(`The ${id} app is already installed.`);
      }

      const app = appInfo(files, id);

      const loading = gateway
        .restore(id, { app })
        .catch(async (cause: unknown) => {
          await gateway.restore(id, undefined);
          folders.remove(id);
          options.appsChanged();
          throw cause;
        });

      const loaded = await Promise.race([
        loading.then(() => true),
        setTimeout(INSTALL_WAIT_MS, false),
      ]);

      // An app whose server code is Imp's runs as the repository has it, so Imp's updates reach it; any other is the
      // person's.
      if (app.impServer) {
        folders.installShipped(id);
      } else {
        folders.remove(id);
        folders.put(id, "live", files);
      }

      options.appsChanged();

      if (!loaded) {
        loading.catch((cause: unknown) => {
          options.log(
            `studio: ${id} did not load, so it was removed: ${String(cause)}`
          );
        });
      }

      if (builds.current() !== undefined) {
        options.rebuildLater();
      }
    },
    /**
     * Removes the app: its versions, their history and its data. The shell lists it no more, so its screen can stay in
     * the served build until the next one.
     */
    uninstall: async (id: string) => {
      if (!APP_ID.test(id) || !(gateway.live(id) || gateway.draft(id))) {
        throw new Error(`There is no ${id} app.`);
      }

      gateway.dropDraft(id);
      await gateway.restore(id, undefined);
      folders.uninstall(id);
      options.appsChanged();
    },
  };
}

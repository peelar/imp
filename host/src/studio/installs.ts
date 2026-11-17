// The person's Install and Uninstall, apart from the decisions on a draft (decisions.ts). Install puts in an app Imp
// ships, as the onboarding does with GitHub and the app directory with Todos; Uninstall removes any app with its data.
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
};

export function appInstalls(options: InstallsOptions) {
  const { gateway, folders, builds } = options;

  return {
    /**
     * Installs an app Imp ships. The served build is rebuilt only when it is the host's: the repository's has every one.
     * The rebuild runs after the answer, as it can take minutes (installing Exact first, on a new host): a caller that
     * gives up on a slow answer (the Mac app's after 60 s) would never send what it does next, such as the onboarding's
     * ask to build the first app.
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

      try {
        await gateway.restore(id, { app });
      } catch (error) {
        await gateway.restore(id, undefined);
        throw error;
      }

      // An app whose server code is Imp's runs as the repository has it, so Imp's updates reach it; any other is the
      // person's.
      if (app.impServer) {
        folders.installShipped(id);
      } else {
        folders.remove(id);
        folders.put(id, "live", files);
      }

      options.appsChanged();

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

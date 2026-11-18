// The agent's way into the studio: a section of its prompt that says how apps are made, and two tools. `app_code`
// writes an app's current code into its workspace; `preview_app` checks what it wrote and shows it to the user.
import {
  defineExtension,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import type { AppFiles, AppGateway } from "../apps/apps.ts";
import { type AgentWorkspace, requireAppId, starter } from "./workspace.ts";

export type StudioToolsOptions = {
  readonly gateway: AppGateway;
  readonly workspace: AgentWorkspace;
  /** Where the agent works on its files. */
  readonly workspaceDir: () => string;
  /** The apps Imp ships, by id: the code of one the person does not have installed. */
  readonly shipped: ReadonlyMap<string, AppFiles>;
  /** Checks the workspace's version of an app and makes it the app's draft; answers what to tell the agent. */
  readonly preview: (id: string) => Promise<string>;
};

const text = (value: string) => ({
  output: [{ type: "text" as const, text: value }],
});

/**
 * Writes an app's current code (its draft, else its live version, else the app as Imp ships it, else a starter) into
 * the agent's workspace.
 */
async function appCode(options: StudioToolsOptions, id: string) {
  requireAppId(id);

  const draft = options.gateway.draft(id);
  const live = options.gateway.live(id);
  const shipped = options.shipped.get(id);

  const base = await options.workspace.write(
    id,
    draft?.files ?? live?.files ?? shipped ?? starter(id)
  );

  let what =
    "a starter app (a list of notes) to change into what the user asked for";

  if (draft) {
    what = "the draft the user is previewing";
  } else if (live) {
    what = "the saved version";
  } else if (shipped) {
    what = "the app as Imp ships it, which the user does not have installed";
  }

  return `Wrote ${base}/${id}/ (${what}). Read ${base}/GUIDE.md before you change it; call preview_app("${id}") when it is ready.`;
}

export function studioTools(options: StudioToolsOptions) {
  return defineExtension({
    name: "studio",
    sections: [
      section(
        "studio",
        () =>
          `You build apps for the user, and change them, when they ask. An app is a folder of three files you write in ${options.workspaceDir()}/apps/<id>/: call app_code first (it writes the app's current code, or a starter, and apps/GUIDE.md, which explains the rest), edit, then call preview_app. The user tries the preview in the app's tab and saves it; you never can. Keep improving it with them until they do. When the user asks you to build them an app, build a new one from app_code's starter, under an id no app has, even where Imp ships one like it (such as GitHub); start from an app they have, or one Imp ships, only when they ask to change or install that one. To install an app from a GitHub repository, clone it on your computer, copy its app folder (app.json, app.contract and server.ts) to apps/<its id>/ in your workspace, and preview it. An app that reads a service needs the user's key for it, such as the GitHub app's key named github: never wait for one. Build and preview the app anyway, and if your secrets list no such key, ask for it with request_secret and tell the user the app fills in once they add it.`
      ),
    ],
    tools: [
      defineTool({
        name: "app_code",
        description:
          "Write an app's current code into apps/<app>/ in your workspace, with apps/GUIDE.md: its draft if the user is previewing one, else its saved version, else the app as Imp ships it (such as todos), else (a new app) a working starter to change. Call it before you build or change an app.",
        parameters: obj({
          app: str({
            description:
              'The app\'s id: lowercase letters and digits, such as "calendar".',
          }),
        }),
        execute: async ({ app }) => text(await appCode(options, app)),
      }),
      defineTool({
        name: "preview_app",
        description:
          "Check apps/<app>/ in your workspace and, if it passes, show it to the user as a preview in the app's tab, on a copy of their data. Fails with what to fix: server.ts that does not load, migrations that do not apply, or a screen that does not compile.",
        parameters: obj({
          app: str({ description: "The app's id, the folder's name." }),
        }),
        execute: async ({ app }) => text(await options.preview(app)),
      }),
    ],
  });
}

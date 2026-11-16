// The agent's way into the studio: a section of its prompt that says how apps are made, and two tools. `app_code`
// writes an app's current code into its workspace; `preview_app` checks what it wrote and shows it to the user.
import {
  defineExtension,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import type { AppGateway } from "../apps/apps.ts";
import { type AgentWorkspace, requireAppId, starter } from "./workspace.ts";

export type StudioToolsOptions = {
  readonly gateway: AppGateway;
  readonly workspace: AgentWorkspace;
  /** Where the agent works on its files. */
  readonly workspaceDir: () => string;
  /** Checks the workspace's version of an app and makes it the app's draft; answers what to tell the agent. */
  readonly preview: (id: string) => Promise<string>;
};

const text = (value: string) => ({
  output: [{ type: "text" as const, text: value }],
});

/** Writes an app's current code (its draft, else its live version, else a starter) into the agent's workspace. */
async function appCode(options: StudioToolsOptions, id: string) {
  requireAppId(id);
  options.gateway.requireOn(id);

  const draft = options.gateway.draft(id);
  const live = options.gateway.live(id);

  const base = await options.workspace.write(
    id,
    draft?.files ?? live?.files ?? starter(id)
  );

  let what =
    "a starter app (a list of notes) to change into what the user asked for";

  if (draft) {
    what = "the draft the user is previewing";
  } else if (live) {
    what = "the saved version";
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
          `You build apps for the user, and change them, when they ask. An app is a folder of three files you write in ${options.workspaceDir()}/apps/<id>/: call app_code first (it writes the app's current code, or a starter, and apps/GUIDE.md, which explains the rest), edit, then call preview_app. The user tries the preview in the app's tab and saves it; you never can. Keep improving it with them until they do. To install an app from a GitHub repository, clone it on your computer, copy its app folder (app.json, app.contract and server.ts) to apps/<its id>/ in your workspace, and preview it.`
      ),
    ],
    tools: [
      defineTool({
        name: "app_code",
        description:
          "Write an app's current code into apps/<app>/ in your workspace, with apps/GUIDE.md: its draft if the user is previewing one, else its saved version, else (a new app) a working starter to change. Call it before you build or change an app.",
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

// An app's folder on its way between the agent's workspace, on the agent's machine, and the host. The agent works on
// `apps/<id>/` there; the host reads the three files when the agent asks for a preview, and writes an app's current
// code there, with what the agent needs to read beside it, when the agent asks for it. Nothing else crosses over.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { RemoteExecutionEnv } from "@earendil-works/pi-env";
import {
  APP_FILES,
  APP_ID,
  type AppFiles,
  readAppFiles,
} from "./app-folders.ts";

const STUDIO_FILES = path.join(import.meta.dirname, "..", "studio");
const SDK = path.join(import.meta.dirname, "..", "..", "sdk", "app.ts");

/** Exact's guides the agent reads to write a screen. */
const EXACT_DOCS = ["start-here.md", "contract-for-agents.md"];

export type AgentWorkspaceOptions = {
  /** The agent's files, and where it works on them: the current computer's, which the owner may switch. */
  readonly files: () => RemoteExecutionEnv;
  readonly workspace: () => string;
  /** The Exact checkout, for its guides. */
  readonly exact: string;
  readonly context: Context;
};

export type AgentWorkspace = ReturnType<typeof agentWorkspace>;

type AppFile = (typeof APP_FILES)[number];

/** A file to write into the workspace, by its path there. */
type WorkspaceFile = { readonly file: string; readonly content: string };

/** Throws what an app's id must be, unless `id` is one. */
export function requireAppId(id: string) {
  if (!APP_ID.test(id)) {
    throw new Error(
      `An app's id is lowercase letters and digits, such as "calendar"; "${id}" is not.`
    );
  }
}

/** A new app's files: a list of notes named for the app, to change into what the user asked for. */
export const starter = (id: string): AppFiles => {
  const name = id.charAt(0).toUpperCase() + id.slice(1);
  const files = readAppFiles(path.join(STUDIO_FILES, "starter"));

  return {
    ...files,
    "app.json": files["app.json"]
      .replaceAll("{{id}}", id)
      .replaceAll("{{name}}", name),
  };
};

export function agentWorkspace(options: AgentWorkspaceOptions) {
  const { context } = options;

  /** What the agent reads beside its apps, as files under `base`: the guide, the SDK and Exact's guides. */
  const reading = (base: string): WorkspaceFile[] => [
    {
      file: `${base}/GUIDE.md`,
      content: readFileSync(path.join(STUDIO_FILES, "GUIDE.md"), "utf-8"),
    },
    { file: `${base}/sdk.ts`, content: readFileSync(SDK, "utf-8") },
    ...EXACT_DOCS.flatMap((doc) => {
      const guide = path.join(options.exact, "docs", doc);

      return existsSync(guide)
        ? [
            {
              file: `${base}/docs/${doc}`,
              content: readFileSync(guide, "utf-8"),
            },
          ]
        : [];
    }),
  ];

  const makeDir = async (dir: string) => {
    const made = await options
      .files()
      .createDir(dir, { recursive: true }, context);

    if (!made.ok) {
      throw new Error(`Could not make ${dir}: ${made.error.message}`);
    }
  };

  /** Writes one file; answers what went wrong, if anything did. */
  const write = async ({ file, content }: WorkspaceFile) => {
    const written = await options.files().writeFile(file, content, context);

    return written.ok
      ? []
      : [`Could not write ${file}: ${written.error.message}`];
  };

  return {
    /** Reads `apps/<id>/` from the agent's workspace. */
    async read(id: string): Promise<AppFiles> {
      const folder = `${options.workspace()}/apps/${id}`;

      const read = async (name: AppFile) => ({
        name,
        text: await options.files().readTextFile(`${folder}/${name}`, context),
      });

      const content = ({ name, text }: Awaited<ReturnType<typeof read>>) => {
        if (!text.ok) {
          throw new Error(
            `Could not read apps/${id}/${name} in your workspace: ${text.error.message}`
          );
        }

        return text.value;
      };

      // The three files are read together; when several are missing, the error names the first.
      const [json, contract, server] = await Promise.all([
        read("app.json"),
        read("app.contract"),
        read("server.ts"),
      ]);

      return {
        "app.json": content(json),
        "app.contract": content(contract),
        "server.ts": content(server),
      };
    },
    /**
     * Writes an app's files as `apps/<id>/` in the agent's workspace, with what the agent reads beside them. Answers
     * the workspace's apps folder.
     */
    async write(id: string, files: AppFiles) {
      const base = `${options.workspace()}/apps`;
      const beside = reading(base);

      // The app's folder first, which makes the apps folder too; then the guides' folder beside it.
      await makeDir(`${base}/${id}`);

      if (beside.some(({ file }) => file.startsWith(`${base}/docs/`))) {
        await makeDir(`${base}/docs`);
      }

      const failures = await Promise.all(
        [
          ...APP_FILES.map((name) => ({
            file: `${base}/${id}/${name}`,
            content: files[name],
          })),
          ...beside,
        ].map(write)
      );

      // The files are written together; when several fail, the error names the first.
      const [failure] = failures.flat();

      if (failure !== undefined) {
        throw new Error(failure);
      }

      return base;
    },
  };
}

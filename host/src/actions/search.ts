// find_actions' search: every app's operations the imp may run and every connected server's tools, matched by the
// words of the query against their names, descriptions and params, best first.
import type { Json } from "../../../sdk/app.ts";
import { paramsSchema } from "../apps/apps.ts";
import type { ActionsOptions } from "./actions.ts";

/** How many actions one search returns at most. */
const FOUND = 20;

/** "setDone" and "create_issue" as "set done" and "create issue", so a search for "done" or "issue" finds them. */
const spaced = (name: string) =>
  name.replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll(/[_-]+/g, " ");

/** An action as find_actions answers it: an app's operation, or a server's tool. */
type FoundAction =
  | {
      readonly app: string;
      readonly action: string;
      readonly kind: string;
      readonly description: string;
      readonly params: Json;
    }
  | {
      readonly server: string;
      readonly action: string;
      readonly kind: string;
      readonly destructive: boolean;
      readonly description: string;
      readonly params: Json;
    };

/** An action, and the words a search matches it by. */
type Found = {
  readonly action: FoundAction;
  readonly words: readonly string[];
};

async function appActions({ apps }: ActionsOptions) {
  return await Promise.allSettled(
    apps.apps().map(async (app) =>
      (await apps.operations(app.id)).flatMap((operation): Found[] => {
        const { name, kind, description, params } = operation;

        return operation.agent
          ? [
              {
                action: {
                  app: app.id,
                  action: name,
                  kind,
                  description,
                  params: paramsSchema(params),
                },
                words: [
                  app.id,
                  app.name,
                  app.description,
                  spaced(name),
                  description,
                  ...Object.keys(params).map(spaced),
                ],
              },
            ]
          : [];
      })
    )
  );
}

async function serverActions({ servers }: ActionsOptions) {
  return await Promise.allSettled(
    servers.list().map(async (server) =>
      (await servers.tools(server.id)).map((tool): Found => ({
        action: {
          server: server.id,
          action: tool.name,
          kind: tool.readOnly ? "read" : "write",
          destructive: tool.destructive,
          description: tool.description,
          params: tool.params,
        },
        words: [
          server.id,
          server.name,
          spaced(tool.name),
          tool.title,
          tool.description,
          ...tool.paramNames.map(spaced),
        ],
      }))
    )
  );
}

/** The actions that match `query`, best first, and why any app or server could not be searched. */
export async function findActions(options: ActionsOptions, query: string) {
  const settled = [
    ...(await appActions(options)),
    ...(await serverActions(options)),
  ];

  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

  const found = settled
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .flatMap(({ action, words: about }) => {
      const haystack = about.join(" ").toLowerCase();
      const score = words.filter((word) => haystack.includes(word)).length;

      return words.length === 0 || score > 0 ? [{ score, action }] : [];
    })
    .toSorted((a, b) => b.score - a.score);

  return {
    actions: found.slice(0, FOUND).map(({ action }) => action),
    problems: settled.flatMap((result) =>
      result.status === "rejected"
        ? [
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
          ]
        : []
    ),
  };
}

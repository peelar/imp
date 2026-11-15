// The agent's way into the user's apps: two tools, the same whichever apps are installed, so its tool list never
// changes. A section of its prompt lists the apps, so it knows to look.
import { isJsonValue } from "@earendil-works/chord/json";
import {
  defineExtension,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import { bool, map, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import type { Json } from "../../../sdk/app.ts";
import type { AppInfo } from "./folders.ts";
import type { Args, Operation } from "./protocol.ts";

/** How many actions one search returns at most. */
const FOUND = 20;

export type AppToolsOptions = {
  /** The user's saved apps. */
  readonly apps: () => readonly AppInfo[];
  /** A saved app's operations, once it loaded; throws why it did not. */
  readonly operations: (id: string) => Promise<readonly Operation[]>;
  /** Runs an operation the agent may run, in the saved app or in its draft. */
  readonly run: (action: {
    readonly app: string;
    readonly name: string;
    readonly args: Args;
    readonly draft: boolean;
  }) => Promise<Json>;
};

const isText = (value: Json): value is string => typeof value === "string";

const text = (text: string) => ({ output: [{ type: "text" as const, text }] });

/** "setDone" as "set done", so a search for "done" finds it. */
const spaced = (name: string) => name.replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2");

/** Everything a search may match an action by. */
const searchable = (app: AppInfo, operation: Operation) =>
  [
    app.id,
    app.name,
    app.description,
    spaced(operation.name),
    operation.description,
    ...Object.keys(operation.params).map(spaced),
  ]
    .join(" ")
    .toLowerCase();

/** The agent's actions that match `query`, best first, and why any app could not be searched. */
async function findActions(options: AppToolsOptions, query: string) {
  const settled = await Promise.allSettled(
    options.apps().map(async (app) => ({
      app,
      operations: await options.operations(app.id),
    }))
  );

  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

  const found = settled
    .flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
    .flatMap(({ app, operations }) =>
      operations.flatMap((operation) => {
        const haystack = searchable(app, operation);
        const score = words.filter((word) => haystack.includes(word)).length;
        const { name, kind, description, params } = operation;

        return operation.agent && (words.length === 0 || score > 0)
          ? [
              {
                score,
                action: {
                  app: app.id,
                  action: name,
                  kind,
                  description,
                  params,
                },
              },
            ]
          : [];
      })
    )
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

export function appTools(options: AppToolsOptions) {
  return defineExtension({
    name: "apps",
    sections: [
      section("apps", () => {
        const list = options
          .apps()
          .map(
            (app) =>
              `- ${app.name} (${app.id})${app.description ? `: ${app.description}` : ""}`
          );

        return list.length === 0
          ? "The user has no apps yet."
          : `The user's apps:\n${list.join("\n")}\nTo use one, find what it can do with find_app_actions, then do it with run_app_action. The user sees every change in the app at once.`;
      }),
    ],
    tools: [
      defineTool({
        name: "find_app_actions",
        description:
          'Search what the user\'s apps can do, by keywords such as "add todo". An empty query lists every action. Each result names the app, the action, whether it reads or writes, and its params.',
        parameters: obj({
          query: opt(
            str({ description: "Keywords; empty lists every action." })
          ),
        }),
        execute: async ({ query = "" }) => {
          const { actions, problems } = await findActions(options, query);

          if (actions.length === 0 && problems.length === 0) {
            return text(
              query
                ? `No action matches "${query}". Try other words, or an empty query to list every action.`
                : "No app has any actions."
            );
          }

          return text(
            JSON.stringify(
              problems.length > 0 ? { actions, problems } : actions
            )
          );
        },
      }),
      defineTool({
        name: "run_app_action",
        description:
          "Run an action find_app_actions returned, in the user's app. `args` holds its params by name. A write changes the user's data, which they see at once. With `draft: true` it runs in the app's draft instead, on the preview's copy of the data.",
        parameters: obj({
          app: str({ description: 'The app\'s id, such as "todos".' }),
          action: str({ description: 'The action\'s name, such as "add".' }),
          args: opt(
            map(unknown(), { description: "The action's params by name." })
          ),
          draft: opt(
            bool({
              description:
                "Run it in the app's draft (its preview) instead of the saved app.",
            })
          ),
        }),
        execute: async ({ app, action, args = {}, draft = false }) => {
          // The model's arguments arrive as JSON; this says so to the types.
          if (!isJsonValue(args)) {
            throw new Error("args must be JSON.");
          }

          const value = await options.run({ app, name: action, args, draft });

          return text(isText(value) ? value : JSON.stringify(value));
        },
      }),
    ],
  });
}

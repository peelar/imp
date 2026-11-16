// The person's side of the apps: each app's own reads and writes, under the names its screen calls them
// (`todosSetDone` for the todos app's `setDone`), and Sync now. An app's name that no app owns is nobody's.
import type { Json } from "../../../sdk/app.ts";
import {
  type Call,
  type Calls,
  type LiveSource,
  ok,
  refused,
  text,
  why,
} from "../live/live.ts";
import type { AppGateway } from "./apps.ts";
import { appTopic } from "./folders.ts";

/** What an app's screen reads under `source`, with its arguments in order; undefined when no app owns the name. */
export function appSource(
  gateway: AppGateway,
  source: string,
  args: readonly Json[]
): LiveSource | undefined {
  const route = gateway.route(source);

  return route
    ? {
        topics: [appTopic(route.app)],
        load: async () =>
          await gateway.fromShell({ ...route, kind: "read", args }),
      }
    : undefined;
}

/** The change an app owns under `source`, if any; a write that fails says why. */
export function appCall(gateway: AppGateway, source: string): Call | undefined {
  const route = gateway.route(source);

  return route
    ? async (args) => {
        try {
          return await gateway.fromShell({ ...route, kind: "write", args });
        } catch (error) {
          return refused(why(error));
        }
      }
    : undefined;
}

export function appsCalls(gateway: AppGateway): Calls {
  return [
    [
      "appsSync",
      async (args) => {
        const failed = await gateway.syncNow(text(args, 0));

        return failed === undefined ? ok : refused(failed);
      },
    ],
  ];
}

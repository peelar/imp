// The catalogue of what the imp can do for the user outside its computer: the user's apps' operations and the tools
// of the MCP servers they connected, behind one search and one run (tools.ts). It owns how the imp finds them and the
// rules a run follows; the apps and the servers are the app gateway's and the connections' own, which host.ts hands
// it: the gateway's `agent`, and the servers in the shape below.
import type { Json } from "../../../sdk/app.ts";
import type { AppGateway, Operation } from "../apps/apps.ts";

export { actionsExtension } from "./tools.ts";

/** The user's saved apps, their operations and a run of one the imp may run (the app gateway's `agent`). */
type AppActions = {
  readonly apps: () => readonly {
    readonly id: string;
    readonly name: string;
    readonly description: string;
  }[];
  /** A saved app's operations, once it loaded; throws why it did not. */
  readonly operations: (id: string) => Promise<readonly Operation[]>;
  readonly run: AppGateway["agent"]["run"];
};

/** One tool of a connected MCP server. */
export type ServerTool = {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** The JSON schema of its arguments, and the names of the arguments it takes. */
  readonly params: Json;
  readonly paramNames: readonly string[];
  /** Its server says it changes nothing (readOnlyHint). */
  readonly readOnly: boolean;
  /** Its server says a run may destroy or overwrite something (destructiveHint, true unless it says otherwise). */
  readonly destructive: boolean;
};

/** What a server's tool answered, as text, and whether it said it failed. */
export type ServerAnswer = { readonly text: string; readonly error: boolean };

/** The MCP servers the user connected and signed in to (the connections'). */
type ServerActions = {
  readonly list: () => readonly {
    readonly id: string;
    readonly name: string;
  }[];
  /** The server's tools; throws why it could not list them, such as a sign-in that expired. */
  readonly tools: (id: string) => Promise<readonly ServerTool[]>;
  readonly call: (
    id: string,
    tool: string,
    args: { readonly [name: string]: Json }
  ) => Promise<ServerAnswer>;
};

export type ActionsOptions = {
  readonly apps: AppActions;
  readonly servers: ServerActions;
};

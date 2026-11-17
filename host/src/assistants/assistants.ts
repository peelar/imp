// Other assistants: Claude Code, Cursor and any other MCP client on the owner's tailnet, using the apps the owner shares
// with them in Settings → Assistants. Each shared app's operations are MCP tools, one per operation, such as
// `todos_add`, served at /mcp (mcp.ts) behind the same Tailscale gate as the rest of the host. A call runs the way the
// imp's own run_app_action does (apps/apps.ts, `agent`), so the owner's open views update at once; operations an app
// keeps from the agent, and drafts, are never offered. No app is shared until the owner turns it on, since what a tool
// answers goes to the other assistant's model. The owner's choice is DATA_DIR/assistants.json.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { arr, compile, lit, obj, str } from "@earendil-works/pi-schema";
import type { Json, Param } from "../../../sdk/app.ts";
import {
  type AgentApps,
  type AppInfo,
  type Operation,
  OPERATIONS_TOPIC,
} from "../apps/apps.ts";
import { readKept } from "../datadir/datadir.ts";
import type { Topics } from "../live/live.ts";
import { mcpServer, type Tool } from "./mcp.ts";

export { assistantsCalls } from "./shell.ts";

/** The topic that changes when the owner shares an app or stops sharing it. */
export const TOPIC = "assistants";

export type AssistantsOptions = {
  readonly dataDir: string;
  readonly topics: Topics;
  readonly apps: AgentApps;
  /** The running release's tag, which the MCP server names itself with. */
  readonly version: string;
  readonly log: (message: string) => void;
};

/** An app as Settings → Assistants lists it, with whether it is shared. */
export type SharedApp = {
  readonly id: string;
  readonly name: string;
  readonly symbol: string;
  readonly shared: boolean;
};

export type Assistants = ReturnType<typeof openAssistants>;

const chosenFile = compile(obj({ apps: arr(str()) }));

const INSTRUCTIONS =
  "These tools are the user's own apps in Imp, one tool per action, named <app>_<action>. A read only answers; a write changes the user's data, and they see the change at once.";

/** A param as JSON Schema. */
const property = (param: Param): Json => {
  const described = param.description ? { description: param.description } : {};

  return param.type === "enum"
    ? { type: "string", enum: [...param.values], ...described }
    : { type: param.type, ...described };
};

/** An app's operation as an MCP tool. */
const tool = (app: AppInfo, operation: Operation): Tool => {
  const params = Object.entries(operation.params);

  return {
    name: `${app.id}_${operation.name}`,
    title: `${app.name}: ${operation.name}`,
    description: `${app.name}: ${operation.description}`,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        params.map(([name, param]) => [name, property(param)])
      ),
      required: params.flatMap(([name, param]) =>
        param.optional ? [] : [name]
      ),
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: operation.kind === "read",
      destructiveHint: operation.kind === "write",
    },
  };
};

const isText = (value: Json): value is string => typeof value === "string";

/** An operation's answer that is the shell's Reply with `ok: false`: it did not do what it was asked. */
const refusedReply = compile(obj({ ok: lit(false) }, { open: true }));

export function openAssistants(options: AssistantsOptions) {
  const { apps, topics } = options;
  const file = path.join(options.dataDir, "assistants.json");

  const chosen = () => new Set(readKept(file, chosenFile, options.log)?.apps);

  /** The saved apps the owner shares. */
  const sharedApps = () => {
    const ids = chosen();

    return apps.apps().filter((app) => ids.has(app.id));
  };

  /** Every tool: each shared app's operations the agent may run, as the app last loaded. */
  const tools = () =>
    sharedApps().flatMap((app) =>
      (apps.known(app.id) ?? []).flatMap((operation) =>
        operation.agent ? [tool(app, operation)] : []
      )
    );

  const mcp = mcpServer({
    version: options.version,
    instructions: INSTRUCTIONS,
    tools,
    // A tool `tools/list` offers (mcp.ts checks): `<app>_<operation>`, and app ids have no underscore.
    call: async (name, args) => {
      const [app = "", action = ""] = name.split("_");

      try {
        const value = await apps.run({
          app,
          name: action,
          args,
          draft: false,
        });

        return {
          text: isText(value) ? value : JSON.stringify(value),
          isError: refusedReply.check(value),
        };
      } catch (error) {
        return {
          text: error instanceof Error ? error.message : String(error),
          isError: true,
        };
      }
    },
  });

  // The tools change when an app loads, stops or is shared: say so only when the list a client would see differs.
  let listed = JSON.stringify(tools());

  const followTools = () => {
    const now = JSON.stringify(tools());

    if (now !== listed) {
      listed = now;
      mcp.toolsChanged();
    }
  };

  const stops = [
    topics.on(OPERATIONS_TOPIC, followTools),
    topics.on(TOPIC, followTools),
  ];

  return {
    /** The saved apps, and which of them the owner shares, for Settings → Assistants (on the account stream). */
    state: (): SharedApp[] => {
      const ids = chosen();

      return apps.apps().map(({ id, name, symbol }) => ({
        id,
        name,
        symbol,
        shared: ids.has(id),
      }));
    },
    /** Shares a saved app with other assistants, or stops sharing it; false when there is no such app. */
    share(id: string, shared: boolean): boolean {
      if (!apps.apps().some((app) => app.id === id)) {
        return false;
      }

      const ids = chosen();

      if (shared) {
        ids.add(id);
      } else {
        ids.delete(id);
      }

      writeFileSync(file, `${JSON.stringify({ apps: [...ids].toSorted() })}\n`);
      topics.changed(TOPIC);

      return true;
    },
    /** Answers a request to /mcp, which the host reached at `origin`. */
    serve: mcp.serve,
    close() {
      for (const stop of stops) {
        stop();
      }

      mcp.close();
    },
  };
}

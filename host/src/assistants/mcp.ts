// The Model Context Protocol over its Streamable HTTP transport, at /mcp: the server side, with tools only. Each POST
// carries one JSON-RPC message, and a request's answer comes back as JSON. A GET opens an event stream that carries
// the one message the server starts itself, that the tools changed. There are no sessions: every request stands
// alone, and the tools are the same for every client. What the tools are and what a call does is assistants.ts's.
import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import {
  arr,
  bool,
  compile,
  lit,
  map,
  nul,
  num,
  obj,
  opt,
  recursive,
  type Static,
  str,
  union,
  unknown,
} from "@earendil-works/pi-schema";
import type { Json } from "../../../sdk/app.ts";
import type { Args } from "../apps/apps.ts";

/** The protocol versions this server speaks, newest first. */
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

const HEARTBEAT_MS = 20_000;

/** A tool as `tools/list` lists it. */
export type Tool = {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Json;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
  };
};

/** What a tool call answers: its text, and whether it failed. */
type ToolResult = { readonly text: string; readonly isError: boolean };

export type McpOptions = {
  /** The running release's tag, which the server names itself with. */
  readonly version: string;
  readonly instructions: string;
  readonly tools: () => readonly Tool[];
  /** Runs one of the tools. */
  readonly call: (name: string, args: Args) => Promise<ToolResult>;
};

type Id = string | number;

const json = recursive<Json>("json", (self) =>
  union([nul(), bool(), num(), str(), arr(self), map(self)])
);

const messageSchema = obj(
  {
    jsonrpc: lit("2.0"),
    id: opt(union([str(), num()])),
    method: opt(str()),
    params: opt(map(unknown())),
  },
  { open: true }
);

const message = compile(messageSchema);

type Message = Static<typeof messageSchema>;

const initializeParams = compile(
  obj({ protocolVersion: opt(str()) }, { open: true })
);

const toolCall = compile(
  obj({ name: str(), arguments: opt(map(json)) }, { open: true })
);

/** A JSON-RPC failure, with its code. */
class RefusalError extends Error {
  readonly code: number;

  constructor(code: number, why: string) {
    super(why);
    this.name = "RefusalError";
    this.code = code;
  }
}

function sendJson(res: ServerResponse, status: number, value?: Json) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(value === undefined ? "" : JSON.stringify(value));
}

const failure = (id: Id | null, code: number, why: string): Json => ({
  jsonrpc: "2.0",
  id,
  error: { code, message: why },
});

/** The version to speak with a client that asked for one: its own when this server speaks it, else the newest. */
function agreed({ params }: Message) {
  const asked = initializeParams.check(params) ? params.protocolVersion : "";

  return asked && VERSIONS.includes(asked) ? asked : (VERSIONS[0] ?? "");
}

async function runTool(
  options: McpOptions,
  { params }: Message
): Promise<Json> {
  // The arguments are checked as JSON here, and against the operation's params where it runs.
  if (!toolCall.check(params)) {
    throw new RefusalError(
      -32_602,
      "tools/call needs a tool's name, and its arguments as a JSON object."
    );
  }

  // Only a tool the list offers runs: whatever is not listed, such as an operation kept from the agent, is unknown.
  if (!options.tools().some((tool) => tool.name === params.name)) {
    throw new RefusalError(-32_602, `Unknown tool: ${params.name}`);
  }

  const result = await options.call(params.name, params.arguments ?? {});

  return {
    content: [{ type: "text", text: result.text }],
    isError: result.isError,
  };
}

/** What a request answers, by its method. */
async function answer(options: McpOptions, request: Message): Promise<Json> {
  switch (request.method ?? "") {
    case "initialize": {
      return {
        protocolVersion: agreed(request),
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "imp", title: "Imp", version: options.version },
        instructions: options.instructions,
      };
    }

    case "ping": {
      return {};
    }

    case "tools/list": {
      return { tools: [...options.tools()] };
    }

    case "tools/call": {
      return await runTool(options, request);
    }

    default: {
      throw new RefusalError(
        -32_601,
        `Method not found: ${request.method ?? ""}`
      );
    }
  }
}

async function post(
  options: McpOptions,
  req: IncomingMessage,
  res: ServerResponse
) {
  let value: unknown;

  try {
    value = JSON.parse(await text(req));
  } catch {
    sendJson(res, 400, failure(null, -32_700, "The body is not JSON."));

    return;
  }

  if (!message.check(value)) {
    sendJson(
      res,
      400,
      failure(null, -32_600, "Send one JSON-RPC 2.0 message per request.")
    );

    return;
  }

  const { id } = value;

  // A notification, or the client's answer to a request: nothing to say back.
  if (id === undefined || value.method === undefined) {
    sendJson(res, 202);

    return;
  }

  try {
    sendJson(res, 200, {
      jsonrpc: "2.0",
      id,
      result: await answer(options, value),
    });
  } catch (error) {
    sendJson(
      res,
      200,
      error instanceof RefusalError
        ? failure(id, error.code, error.message)
        : failure(
            id,
            -32_603,
            error instanceof Error ? error.message : String(error)
          )
    );
  }
}

/** The event stream a GET opens, which says when the tools changed, until the client goes away. */
function listen(
  streams: Set<ServerResponse>,
  req: IncomingMessage,
  res: ServerResponse
) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": open\n\n");
  streams.add(res);

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, HEARTBEAT_MS);

  req.once("close", () => {
    clearInterval(heartbeat);
    streams.delete(res);
  });
}

export function mcpServer(options: McpOptions) {
  const streams = new Set<ServerResponse>();

  return {
    /**
     * Answers a request to /mcp. `origin` is the address the host was reached at: a browser page from anywhere else
     * is turned away, as the transport asks, so a site the owner has open cannot reach their apps.
     */
    serve: async (
      req: IncomingMessage,
      res: ServerResponse,
      origin: string
    ): Promise<void> => {
      if (req.headers.origin && req.headers.origin !== origin) {
        sendJson(res, 403, failure(null, -32_600, "Not from this origin."));

        return;
      }

      const [version] = [req.headers["mcp-protocol-version"] ?? []].flat();

      if (version !== undefined && !VERSIONS.includes(version)) {
        sendJson(
          res,
          400,
          failure(null, -32_600, `Unsupported protocol version ${version}.`)
        );

        return;
      }

      if (req.method === "POST") {
        await post(options, req, res);
      } else if (req.method === "GET") {
        listen(streams, req, res);
      } else {
        res.setHeader("allow", "GET, POST");
        sendJson(res, 405, failure(null, -32_600, "GET or POST only."));
      }
    },
    /** Tells every open stream that the tools changed, so its client lists them again. */
    toolsChanged() {
      const changed = JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
      });

      for (const res of streams) {
        res.write(`data: ${changed}\n\n`);
      }
    },
    close() {
      for (const res of streams) {
        res.end();
      }

      streams.clear();
    },
  };
}

// What an MCP server sends back, in the catalogue's terms: a tool as the imp finds it, with its hints, and a tool's
// answer as text. Both come from outside the host, so they are checked against a schema before they are read, and a
// tool's description is cut short, since it reaches the imp's context too.
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import { isJsonValue } from "@earendil-works/chord/json";
import {
  arr,
  bool,
  compile,
  map,
  obj,
  opt,
  str,
  unknown,
} from "@earendil-works/pi-schema";
import type { Json } from "../../../sdk/app.ts";

/** How much of a tool's description the imp reads. */
const MAX_DESCRIPTION = 600;

const toolsJson = compile(
  arr(
    obj(
      {
        name: str(),
        title: opt(str()),
        description: opt(str()),
        inputSchema: obj({ properties: opt(map(unknown())) }, { open: true }),
        annotations: opt(
          obj(
            {
              title: opt(str()),
              readOnlyHint: opt(bool()),
              destructiveHint: opt(bool()),
            },
            { open: true }
          )
        ),
      },
      { open: true }
    )
  )
);

const contentJson = compile(
  arr(
    obj(
      {
        type: str(),
        text: opt(str()),
        uri: opt(str()),
        name: opt(str()),
        resource: opt(
          obj({ uri: opt(str()), text: opt(str()) }, { open: true })
        ),
      },
      { open: true }
    )
  )
);

/**
 * The tools a server listed. Without a readOnlyHint a tool counts as a write, and a write as destructive unless its
 * server says it is not, as MCP's defaults say.
 */
export function toolsOf(listed: readonly Tool[]) {
  if (!toolsJson.check(listed)) {
    throw new Error("The server listed tools Imp cannot read.");
  }

  return listed.map((tool) => {
    const hints = tool.annotations;
    const readOnly = hints?.readOnlyHint === true;
    const params: Json = isJsonValue(tool.inputSchema) ? tool.inputSchema : {};

    return {
      name: tool.name,
      title: tool.title ?? hints?.title ?? "",
      description: (tool.description ?? "").slice(0, MAX_DESCRIPTION),
      params,
      paramNames: Object.keys(tool.inputSchema.properties ?? {}),
      readOnly,
      destructive: !readOnly && hints?.destructiveHint !== false,
    };
  });
}

export type ListedTool = ReturnType<typeof toolsOf>[number];

type Block = {
  readonly type: string;
  readonly text?: string | undefined;
  readonly uri?: string | undefined;
  readonly name?: string | undefined;
  readonly resource?:
    | { readonly uri?: string | undefined; readonly text?: string | undefined }
    | undefined;
};

/** One block of a tool's answer, as text. */
function blockText(block: Block) {
  if (block.type === "text") {
    return block.text ?? "";
  }

  if (block.type === "resource_link") {
    return `[link: ${block.name ?? ""} ${block.uri ?? ""}]`;
  }

  if (block.type === "resource") {
    return block.resource?.text ?? `[resource: ${block.resource?.uri ?? ""}]`;
  }

  return `[${block.type}]`;
}

/** A tool's answer as text: its content blocks, or its structured content when it has no text. */
export function answerText(result: CallToolResult) {
  const blocks: readonly Block[] = contentJson.check(result.content)
    ? result.content
    : [];

  const text = blocks.map(blockText).join("\n").trim();

  return {
    text: text || JSON.stringify(result.structuredContent ?? null),
    error: result.isError === true,
  };
}

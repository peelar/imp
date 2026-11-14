// The imp's tricks: browser tasks it recorded once with agent-browser and runs again in a second without the page
// (agent-browser calls them saved flows). They live on the agent's computer, in agent-browser's own store, so the host
// asks agent-browser for them: when a computer connects, and after every turn, in which the imp may have learned one.
import type { Context } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { arr, bool, compile, obj, opt, str } from "@earendil-works/pi-schema";
import type { Topics } from "./live.ts";

export const TOPIC = "tricks";

/** A trick as the shell lists it: `title` says what it does, `site` where, `params` what it asks for each time. */
export type Trick = {
  readonly name: string;
  readonly title: string;
  readonly site: string;
  readonly params: readonly string[];
};

// Open objects: agent-browser says more about each flow than the shell shows.
const listed = compile(
  obj(
    {
      success: bool(),
      data: opt(
        obj(
          {
            flows: arr(
              obj(
                {
                  name: str(),
                  description: opt(str()),
                  origin: str(),
                  params: opt(arr(str())),
                },
                { open: true }
              )
            ),
          },
          { open: true }
        )
      ),
    },
    { open: true }
  )
);

/** "search-stories" as "Search stories", for a trick saved without a description. */
const titled = (name: string) => {
  const words = name.replaceAll(/[-_]+/g, " ").trim();

  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** What `agent-browser flow list --json` printed, as the shell's tricks, in the order of their titles. */
export function parseTricks(output: string): Trick[] {
  const answer: unknown = JSON.parse(output);

  if (!listed.check(answer) || !answer.success) {
    throw new Error("agent-browser flow list did not answer with its flows");
  }

  return (answer.data?.flows ?? [])
    .map((flow) => ({
      name: flow.name,
      title: flow.description?.trim()
        ? flow.description.trim()
        : titled(flow.name),
      site: flow.origin,
      params: flow.params ?? [],
    }))
    .toSorted((a, b) => a.title.localeCompare(b.title));
}

export type TricksOptions = {
  /** The agent's computer, read for each use, so a switch of computer reaches the next one. */
  readonly env: () => Promise<Pick<ExecutionEnv, "exec">>;
  readonly topics: Topics;
  readonly context: Context;
};

export function openTricks({ env, topics, context }: TricksOptions) {
  let list: Trick[] = [];
  let reading: Promise<void> | undefined;

  async function read() {
    let out = "";

    const run = await (
      await env()
    ).exec(
      ["agent-browser", "flow", "list", "--json"],
      {
        onOutput: (chunk, _context, info) => {
          if (info.stream === "stdout") {
            out += chunk;
          }
        },
      },
      context
    );

    if (!run.ok) {
      throw run.error;
    }

    // No agent-browser on this computer (one set up before it was added, until setup runs again): no tricks.
    return run.value.exitCode === 127 ? [] : parseTricks(out);
  }

  async function refresh() {
    try {
      const next = await read();

      if (JSON.stringify(next) !== JSON.stringify(list)) {
        list = next;
        topics.changed(TOPIC);
      }
    } catch (error) {
      // A computer that cannot answer keeps the list it had.
      console.error(
        `tricks: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      reading = undefined;
    }
  }

  return {
    list: () => list,
    /** Reads the tricks again; calls that overlap share one read. */
    async refresh() {
      reading ??= refresh();
      await reading;
    },
  };
}

export type Tricks = ReturnType<typeof openTricks>;

// The agent: who the imp is, the registry every part installs its tools and prompt sections on, and the Pi Durable
// harness that runs it, with its conversations in DATA_DIR/harness.sqlite, so it survives a restart in the middle of a
// turn. Its tools run on the agent's computer: the host hands the harness an environment for each tool call, so a
// switch of computer or a secret added in Settings reaches the next one. Which model answers, which computer it works
// on and what each part offers it are the other parts' own; this context knows none of them.
import path from "node:path";
import type { Context } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineExtension,
  Harness,
  type Registry,
  section,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

type HarnessConfig = Parameters<typeof Harness.open>[1];

/** Who the imp is, said first in its prompt. `workspace` is where its tools run on its computer now. */
const preamble = (workspace: string) =>
  `You are Imp, the user's own imp: a small, clever, loyal helper that runs their errands in the Imp app. You use their apps for them and build new apps when they ask. You have your own Linux computer: the read, write, edit, and bash tools run on it, in ${workspace}. Act without asking, except before destructive or irreversible actions. Keep answers short.`;

/**
 * The imp's registry: its computer's file and shell tools, and who it is. Every other part installs its tools and
 * prompt sections after these, so the prompt says who the imp is first.
 */
export function agentRegistry(workspace: () => string): Registry {
  const registry = createRegistry();

  registry.install(CodingTools);
  registry.install(
    defineExtension({
      name: "imp",
      sections: [
        section("preamble", () => preamble(workspace()), { tag: false }),
      ],
    })
  );

  return registry;
}

export type AgentOptions = {
  readonly dataDir: string;
  readonly models: HarnessConfig["models"];
  readonly registry: Registry;
  /** The environment the agent's tools run in, built for each tool call. */
  readonly env: NonNullable<HarnessConfig["env"]>;
  readonly context: Context;
};

/** The harness that runs the imp, on the conversations it kept. */
export async function openHarness(options: AgentOptions) {
  return await Harness.open(
    await openNodeSqliteStorage(path.join(options.dataDir, "harness.sqlite")),
    { models: options.models, registry: options.registry, env: options.env },
    options.context
  );
}

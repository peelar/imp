// The knowledge graph's own names, and the two changes that both the agent's tools (graph.ts) and the
// reflection after a run (reflect.ts) make to it.
import type { KnowledgeGraphManager } from "@modelcontextprotocol/server-memory/dist/index.js";

/** The person the imp works for. */
export const USER = "user";

/** The imp itself. */
export const SELF = "imp";

/** The graph, and how its owner hears that it changed. */
export type Memory = {
  readonly graph: KnowledgeGraphManager;
  readonly changed: () => void;
};

/** Facts to keep about someone or something, which is a `kind` when it is new ("" for the default). */
export type Remembered = {
  readonly about: string;
  readonly kind: string;
  readonly facts: readonly string[];
};

/** Adds the facts, creating what they are about when it is new; answers how many were new. */
export async function rememberFacts(
  graph: KnowledgeGraphManager,
  { about, kind, facts }: Remembered
): Promise<number> {
  const fallback = about === USER || about === SELF ? "person" : "thing";

  await graph.createEntities([
    {
      name: about,
      entityType: kind === "" ? fallback : kind,
      observations: [],
    },
  ]);

  const [result] = await graph.addObservations([
    {
      entityName: about,
      contents: facts.map((fact) => fact.trim()).filter(Boolean),
    },
  ]);

  return result?.addedObservations.length ?? 0;
}

/** Forgets one fact of an entity, or, without a fact, the entity and its relations. */
export async function forgetEntry(
  { graph, changed }: Memory,
  name: string,
  fact: string | undefined
) {
  if (fact) {
    await graph.deleteObservations([
      { entityName: name, observations: [fact] },
    ]);
  } else {
    await graph.deleteEntities([name]);
  }

  changed();
}

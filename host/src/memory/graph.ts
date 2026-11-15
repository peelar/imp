// The default memory: the Model Context Protocol's reference memory server (@modelcontextprotocol/server-memory), used
// as a library. What the imp knows is a knowledge graph of entities (a person, a project, a place), the facts it
// observed about each, and relations between them, kept in one JSONL file in the host's data directory that a person
// can also open in any editor. Two entities are the imp's own: `user`, the person it works for, and `imp`, itself,
// which is how its identity grows past the preamble (a name it is given, how it should speak).
//
// The agent writes to it two ways: with its remember, relate, and forget tools while it works, and, after every run
// that answered, in a background task that reads the run and asks the model what is worth keeping (reflect.ts),
// so nothing depends on the agent thinking to call a tool.
import path from "node:path";
import {
  defineExtension,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import {
  type Entity,
  type KnowledgeGraph,
  KnowledgeGraphManager,
} from "@modelcontextprotocol/server-memory/dist/index.js";
import type { MemoryEntry, MemorySystem } from "./memory.ts";
import {
  forgetEntry,
  type Memory,
  rememberFacts,
  SELF,
  USER,
} from "./facts.ts";
import { reflection } from "./reflect.ts";

export { SELF, USER } from "./facts.ts";

/** How many other entities the prompt names; the agent recalls the rest. */
const NAMED = 60;

/** What the person reads in place of the names of the imp's own two entities. */
const TITLES = new Map([
  [USER, "You"],
  [SELF, "Your imp"],
]);

const GUIDANCE = `Your memory is a knowledge graph that lasts across conversations, and the person can read and change it in Settings. When you learn something lasting, remember it at once, without asking or announcing it: about the person under "${USER}" (their name, the people and things in their life, their plans, what they like and how they like things done), about yourself under "${SELF}" (a name they give you, how they want you to be), and anything else under its own name. Keep each fact short and on its own. Relate entities when it helps, such as "${USER}" has sister "Ola". When a fact changes, forget the old one and remember the new one. Recall before you answer something that may depend on what you know. Never remember passwords, keys, or other secrets.`;

/** A tool's answer to the agent, in words. */
const text = (value: string) => ({
  output: [{ type: "text" as const, text: value }],
});

const bullets = (facts: readonly string[]) =>
  facts.map((fact) => `- ${fact}`).join("\n");

const find = (all: KnowledgeGraph, name: string) =>
  all.entities.find((entity) => entity.name === name);

export const graphMemory: MemorySystem = ({ dataDir, changed }) => {
  const file = path.join(dataDir, "memory.jsonl");
  const memory: Memory = { graph: new KnowledgeGraphManager(file), changed };

  return {
    name: "Knowledge graph",
    location: file,
    extension: defineExtension({
      name: "memory",
      sections: [section("memory", async () => await prompt(memory.graph))],
      tools: [
        rememberTool(memory),
        relateTool(memory),
        recallTool(memory.graph),
        forgetTool(memory),
      ],
      ...reflection(memory),
    }),
    inspect: async () => await inspect(memory.graph),
    forget: async (entry, fact) => {
      await forgetEntry(memory, entry, fact);
    },
  };
};

/** What the agent knows before it recalls anything: itself, its person, and the names of everything else. */
async function prompt(graph: KnowledgeGraphManager): Promise<string> {
  const all = await graph.readGraph();
  const self = find(all, SELF)?.observations ?? [];
  const user = find(all, USER)?.observations ?? [];

  const others = all.entities.filter(
    (entity) => entity.name !== SELF && entity.name !== USER
  );

  const parts = [GUIDANCE];

  parts.push(
    self.length
      ? `What you remember about yourself:\n${bullets(self)}`
      : "You remember nothing about yourself yet.",
    user.length
      ? `What you remember about the person:\n${bullets(user)}`
      : "You remember nothing about the person yet."
  );

  if (others.length) {
    const names = others
      .slice(0, NAMED)
      .map((entity) => `${entity.name} (${entity.entityType})`);

    const more =
      others.length > NAMED ? `, and ${others.length - NAMED} more` : "";

    parts.push(
      `You also remember (recall them for what you know): ${names.join(", ")}${more}.`
    );
  }

  return parts.join("\n\n");
}

function rememberTool({ graph, changed }: Memory) {
  return defineTool({
    name: "remember",
    description: `Remember lasting facts about someone or something: "${USER}" is the person you work for, "${SELF}" is you.`,
    parameters: obj({
      about: str({
        description: `Who or what the facts are about: "${USER}", "${SELF}", or a name such as "Ola" or "Kraków trip".`,
      }),
      kind: opt(
        str({
          description:
            'What sort of thing it is, for a new name: "person", "project", "place", "pet"…',
        })
      ),
      facts: arr(str(), {
        description:
          'Short facts, one per item, such as "Prefers mornings for calls".',
      }),
    }),
    execute: async ({ about, kind, facts }) => {
      const name = about.trim();

      const added = await rememberFacts(graph, {
        about: name,
        kind: kind?.trim() ?? "",
        facts,
      });

      changed();

      return text(
        added
          ? `Remembered ${added} new fact${added === 1 ? "" : "s"} about ${name}.`
          : `Already knew that about ${name}.`
      );
    },
  });
}

function relateTool({ graph, changed }: Memory) {
  return defineTool({
    name: "relate",
    description:
      "Remember how two remembered things relate, such as user → works at → Acme. Remember both first.",
    parameters: obj({
      from: str(),
      relation: str({
        description: 'In the active voice, such as "works at" or "has sister".',
      }),
      to: str(),
    }),
    execute: async ({ from, relation, to }) => {
      await graph.createRelations([
        { from: from.trim(), to: to.trim(), relationType: relation.trim() },
      ]);
      changed();

      return text(`Remembered: ${from} ${relation} ${to}.`);
    },
  });
}

function recallTool(graph: KnowledgeGraphManager) {
  return defineTool({
    name: "recall",
    description:
      "Search memory: everything remembered whose name, kind, or a fact contains the words, with its relations.",
    parameters: obj({
      query: str({
        description: 'A name or a word, such as "Ola" or "birthday".',
      }),
    }),
    execute: async ({ query }) => {
      const found = await graph.searchNodes(query.trim(), { limit: 20 });

      return text(
        found.entities.length
          ? JSON.stringify(found)
          : `Nothing in memory matches "${query}".`
      );
    },
  });
}

function forgetTool(memory: Memory) {
  return defineTool({
    name: "forget",
    description:
      "Forget one fact about someone or something, or, without a fact, everything about them.",
    parameters: obj({
      about: str(),
      fact: opt(str({ description: "The fact exactly as remembered." })),
    }),
    execute: async ({ about, fact }) => {
      await forgetEntry(memory, about.trim(), fact);

      return text(fact ? `Forgot that about ${about}.` : `Forgot ${about}.`);
    },
  });
}

/** The imp first, then its person, then everything else in the order it was remembered. */
function order(entity: Entity): number {
  if (entity.name === SELF) {
    return 0;
  }

  return entity.name === USER ? 1 : 2;
}

/** Everything remembered, as the person reads it. */
async function inspect(graph: KnowledgeGraphManager): Promise<MemoryEntry[]> {
  const all = await graph.readGraph();

  return [...all.entities]
    .sort((a, b) => order(a) - order(b))
    .map((entity) => ({
      id: entity.name,
      title: TITLES.get(entity.name) ?? entity.name,
      kind: TITLES.has(entity.name) ? "" : entity.entityType,
      facts: entity.observations,
      links: all.relations
        .filter((relation) => relation.from === entity.name)
        .map(
          (relation) =>
            `${relation.relationType} → ${TITLES.get(relation.to) ?? relation.to}`
        ),
    }));
}

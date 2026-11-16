// Reflection: after every run that answered, a background task reads the run and asks the model what is worth
// keeping, so the imp's memory does not depend on the agent thinking to call a tool. The model answers JSON, which is
// read leniently: whatever in it is not a change this file knows is ignored.
import type { Context } from "@earendil-works/chord/context";
import {
  defineTask,
  type EntryId,
  type EntryRecord,
  GenerationTask,
  hook,
  runEndTask,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import {
  arr,
  compile,
  obj,
  opt,
  str,
  unknown,
} from "@earendil-works/pi-schema";
import type { KnowledgeGraphManager } from "@modelcontextprotocol/server-memory/dist/index.js";
import {
  type Memory,
  type Remembered,
  rememberFacts,
  SELF,
  USER,
} from "./facts.ts";
import { isRoutineRun, messageText } from "../chats/chats.ts";

/** Reflection reads at most this much of one run, newest last. */
const RUN_CHARS = 12_000;

const REFLECT = `You keep the long-term memory of Imp, a personal assistant, as a knowledge graph. You get what the graph holds now and one exchange between the person and Imp. Find what is worth remembering for later conversations: about the person under "${USER}" (their name, the people and things in their life, their plans, what they like and how they like things done), about Imp under "${SELF}" (a name it is given, how it should be), and about other people, places, and projects under their own names. Skip what only matters for this exchange, what the graph already says, what Imp merely did or said, guesses, and passwords, keys, or other secrets. When a fact in the graph is no longer true, forget it and remember the new one. Most exchanges teach nothing lasting; then answer with empty lists.

Answer with one JSON object and nothing else:
{"remember": [{"about": "user", "kind": "person", "facts": ["Lives in Kraków"]}], "relate": [{"from": "user", "relation": "has sister", "to": "Ola"}], "forget": [{"about": "user", "fact": "Lives in Warsaw"}]}
Keep each fact short and on its own. Use a name the graph already has when you mean that thing.`;

/** One run, by its first and last entries. */
type Run = { first: EntryId; last: EntryId };

type Runtime<Phase extends string> = TaskRuntime<
  Run,
  { phase: Phase },
  null,
  object
>;

/** The changes reflection asks for. */
type Reflection = {
  readonly remember: readonly Remembered[];
  readonly relate: readonly { from: string; relation: string; to: string }[];
  readonly forget: readonly { about: string; fact: string }[];
};

// Open and loose on purpose: a model's answer is taken item by item, and an item that is not a change is dropped.
const answered = compile(
  obj(
    {
      remember: opt(unknown()),
      relate: opt(unknown()),
      forget: opt(unknown()),
    },
    { open: true }
  )
);

const listed = compile(arr(unknown()));
const word = compile(str());

const remembered = compile(
  obj(
    { about: str(), kind: opt(unknown()), facts: arr(unknown()) },
    { open: true }
  )
);

const related = compile(
  obj({ from: str(), relation: str(), to: str() }, { open: true })
);

const forgotten = compile(obj({ about: str(), fact: str() }, { open: true }));

/** The model's answer as changes: the first JSON object in it, with every field checked. */
export function readReflection(answer: string): Reflection {
  let value: unknown;

  try {
    value = JSON.parse(
      answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1)
    );
  } catch {
    value = undefined;
  }

  if (!answered.check(value)) {
    return { remember: [], relate: [], forget: [] };
  }

  const remember = listed.check(value.remember) ? value.remember : [];
  const relate = listed.check(value.relate) ? value.relate : [];
  const forget = listed.check(value.forget) ? value.forget : [];

  return {
    remember: remember.flatMap((item) => {
      const found = remembered.check(item) ? item : undefined;
      const about = found?.about.trim() ?? "";

      const facts = (found?.facts ?? [])
        .filter(word.check)
        .map((fact) => fact.trim())
        .filter(Boolean);

      const kind = word.check(found?.kind) ? found.kind.trim() : "";

      return about && facts.length > 0 ? [{ about, kind, facts }] : [];
    }),
    relate: relate.flatMap((item) => {
      const from = related.check(item) ? item.from.trim() : "";
      const relation = related.check(item) ? item.relation.trim() : "";
      const to = related.check(item) ? item.to.trim() : "";

      return from && relation && to ? [{ from, relation, to }] : [];
    }),
    forget: forget.flatMap((item) => {
      const about = forgotten.check(item) ? item.about.trim() : "";
      const fact = forgotten.check(item) ? item.fact.trim() : "";

      return about && fact ? [{ about, fact }] : [];
    }),
  };
}

/** What an entry says in the exchange, when it holds the person's words or the imp's. */
function spoken(entry: EntryRecord): string[] {
  const [message] = entry.model ?? [];

  if (entry.kind === "pi.user" && message?.role === "user") {
    const said = messageText(message.content);

    // A routine's run: the host wrote it, not the person.
    return said && !isRoutineRun(said) ? [`Person: ${said}`] : [];
  }

  if (entry.kind === "pi.assistant" && message?.role === "assistant") {
    const said = messageText(message.content);

    return said ? [`Imp: ${said}`] : [];
  }

  return [];
}

/** The run's exchange, what the person said and what the imp answered, in words; at most RUN_CHARS, newest kept. */
async function exchange(
  runtime: Runtime<"reflect">,
  run: Run,
  context: Context
) {
  const range = {
    minEntryId: run.first,
    maxEntryId: run.last,
    order: "ascending",
  } as const;

  const lines: string[] = [];
  let cursor: Parameters<typeof runtime.entries>[2];

  do {
    // oxlint-disable-next-line no-await-in-loop -- pages: each one says where the next begins.
    const page = await runtime.entries(range, 200, cursor, context);

    lines.push(...page.items.flatMap(spoken));
    cursor = page.next;
  } while (cursor !== undefined);

  // A run the person said nothing in, such as a routine's, teaches nothing about them.
  if (!lines.some((line) => line.startsWith("Person: "))) {
    return "";
  }

  const all = lines.join("\n\n");

  return all.length > RUN_CHARS ? all.slice(-RUN_CHARS) : all;
}

/** The graph as reflection reads it: every entry with its facts and relations. */
async function graphText(graph: KnowledgeGraphManager): Promise<string> {
  const all = await graph.readGraph();

  if (all.entities.length === 0) {
    return "The graph is empty.";
  }

  return all.entities
    .map((entity) =>
      [
        `${entity.name} (${entity.entityType})`,
        ...entity.observations.map((fact) => `- ${fact}`),
        ...all.relations.flatMap((relation) =>
          relation.from === entity.name
            ? [`- ${relation.relationType} → ${relation.to}`]
            : []
        ),
      ].join("\n")
    )
    .join("\n\n");
}

/** Applies what reflection found; answers whether anything changed. */
async function apply(
  graph: KnowledgeGraphManager,
  found: Reflection
): Promise<boolean> {
  const changes = [
    ...found.forget.map(({ about, fact }) => async () => {
      const { deletedCount } = await graph.deleteObservations([
        { entityName: about, observations: [fact] },
      ]);

      return deletedCount;
    }),
    ...found.remember.map(
      (facts) => async () => await rememberFacts(graph, facts)
    ),
    ...found.relate.map(({ from, relation, to }) => async () => {
      try {
        const made = await graph.createRelations([
          { from, to, relationType: relation },
        ]);

        return made.length;
      } catch {
        // A relation to something never remembered is dropped: the graph refuses it.
        return 0;
      }
    }),
  ];

  let changed = 0;

  for (const change of changes) {
    // oxlint-disable-next-line no-await-in-loop -- the graph rewrites its file for each change, and a later change builds on an earlier one.
    changed += await change();
  }

  return changed > 0;
}

/** Asks the conversation's model what the run taught, and keeps it. */
async function reflectOn(
  { graph, changed }: Memory,
  runtime: Runtime<"reflect">,
  { run, context }: { readonly run: Run; readonly context: Context }
) {
  const said = await exchange(runtime, run, context);
  const { model: ref } = await runtime.agent(context);
  const model = ref && runtime.models.getModel(ref.provider, ref.modelId);

  if (!said || !model) {
    return;
  }

  const answer = await runtime.models.completeSimple(
    model,
    {
      systemPrompt: REFLECT,
      messages: [
        {
          role: "user",
          content: `What the graph holds now:\n\n${await graphText(graph)}\n\nThe exchange:\n\n${said}`,
          timestamp: Date.now(),
        },
      ],
    },
    { signal: runtime.signal }
  );

  if (answer.errorMessage) {
    throw new Error(answer.errorMessage);
  }

  if (await apply(graph, readReflection(messageText(answer.content)))) {
    changed();
  }
}

/** The tasks and the hook that make the imp reflect after its runs, for the memory's extension. */
export function reflection(memory: Memory) {
  /**
   * Reads one run and keeps what it taught. In the background: the conversation is not busy meanwhile, Stop leaves it
   * running, and a restart runs it again, which changes nothing twice, since the graph skips what it already holds.
   */
  const Reflect = defineTask<Run, { phase: "reflect" }, null>({
    name: "memory.reflect",
    version: 1,
    initial: () => ({ phase: "reflect" }),
    phases: {
      reflect: async (task, runtime, context) => {
        try {
          await reflectOn(memory, runtime, { run: task.input, context });
        } catch (error) {
          if (runtime.signal.aborted) {
            throw error;
          }

          // Memory is a nicety: a failed reflection forgets this run, it never fails anything else.
          console.error(
            `memory: reflecting on a run failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: null },
          }),
          context
        );
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context
      );
    },
  });

  /** Asked for by the run's afterRun hook, which waits for it: it only starts Reflect in the background, and ends. */
  const StartReflect = defineTask<Run, { phase: "start" }, null>({
    name: "memory.start-reflect",
    version: 1,
    initial: () => ({ phase: "start" }),
    phases: {
      start: async (task, runtime, context) => {
        await runtime.commit(async (tx) => {
          await tx.createTask(Reflect, task.input, {
            ownership: { kind: "conversation" },
            background: true,
          });

          return {
            status: "terminal",
            outcome: { status: "completed", result: null },
          };
        }, context);
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context
      );
    },
  });

  return {
    tasks: [StartReflect, Reflect],
    hooks: [
      hook(GenerationTask, {
        afterRun: (run) => ({
          tasks: [
            runEndTask(StartReflect, { first: run.first, last: run.last }),
          ],
        }),
      }),
    ],
  };
}

// The default memory: the Model Context Protocol's reference memory server (@modelcontextprotocol/server-memory), used
// as a library. What the imp knows is a knowledge graph of entities (a person, a project, a place), the facts it
// observed about each, and relations between them, kept in one JSONL file in the host's data directory that a person
// can also open in any editor. Two entities are the imp's own: `user`, the person it works for, and `imp`, itself,
// which is how its identity grows past the preamble (a name it is given, how it should speak).
//
// The agent writes to it two ways: with its remember, relate, and forget tools while it works, and, after every run
// that answered, in a background task that reads the run and asks the model what is worth keeping (`Reflect`), so
// nothing depends on the agent thinking to call a tool.
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import {
	defineExtension,
	defineTask,
	defineTool,
	type EntryId,
	GenerationTask,
	hook,
	runEndTask,
	section,
	type TaskRuntime,
} from "@earendil-works/pi-durable";
import { arr, obj, opt, str } from "@earendil-works/pi-schema";
import { type Entity, type KnowledgeGraph, KnowledgeGraphManager } from "@modelcontextprotocol/server-memory/dist/index.js";
import type { MemoryEntry, MemorySystem } from "./memory.ts";

/** The person the imp works for. */
export const USER = "user";
/** The imp itself. */
export const SELF = "imp";
/** How many other entities the prompt names; the agent recalls the rest. */
const NAMED = 60;

const TITLES: Record<string, string> = { [USER]: "You", [SELF]: "Your imp" };

const GUIDANCE = `Your memory is a knowledge graph that lasts across conversations, and the person can read and change it in Settings. When you learn something lasting, remember it at once, without asking or announcing it: about the person under "${USER}" (their name, the people and things in their life, their plans, what they like and how they like things done), about yourself under "${SELF}" (a name they give you, how they want you to be), and anything else under its own name. Keep each fact short and on its own. Relate entities when it helps, such as "${USER}" has sister "Ola". When a fact changes, forget the old one and remember the new one. Recall before you answer something that may depend on what you know. Never remember passwords, keys, or other secrets.`;

/** Reflection reads at most this much of one run, newest last. */
const RUN_CHARS = 12_000;

const REFLECT = `You keep the long-term memory of Imp, a personal assistant, as a knowledge graph. You get what the graph holds now and one exchange between the person and Imp. Find what is worth remembering for later conversations: about the person under "${USER}" (their name, the people and things in their life, their plans, what they like and how they like things done), about Imp under "${SELF}" (a name it is given, how it should be), and about other people, places, and projects under their own names. Skip what only matters for this exchange, what the graph already says, what Imp merely did or said, guesses, and passwords, keys, or other secrets. When a fact in the graph is no longer true, forget it and remember the new one. Most exchanges teach nothing lasting; then answer with empty lists.

Answer with one JSON object and nothing else:
{"remember": [{"about": "user", "kind": "person", "facts": ["Lives in Kraków"]}], "relate": [{"from": "user", "relation": "has sister", "to": "Ola"}], "forget": [{"about": "user", "fact": "Lives in Warsaw"}]}
Keep each fact short and on its own. Use a name the graph already has when you mean that thing.`;

/** One run, by its first and last entries. */
type Run = { first: EntryId; last: EntryId };

/** The changes reflection asks for; whatever else the model answers is ignored. */
interface Reflection {
	remember: { about: string; kind?: string; facts: string[] }[];
	relate: { from: string; relation: string; to: string }[];
	forget: { about: string; fact: string }[];
}

/** The model's answer as changes: the first JSON object in it, with every field checked. */
function readReflection(answer: string): Reflection {
	const none: Reflection = { remember: [], relate: [], forget: [] };
	const json = answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1);
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return none;
	}
	if (typeof value !== "object" || value === null) return none;
	const record = value as Record<string, unknown>;
	const list = (key: string) => (Array.isArray(record[key]) ? (record[key] as unknown[]) : []);
	const words = (v: unknown) => (typeof v === "string" ? v.trim() : "");
	const item = (v: unknown) => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
	return {
		remember: list("remember").flatMap((v) => {
			const { about, kind, facts } = item(v);
			const kept = Array.isArray(facts) ? facts.map(words).filter(Boolean) : [];
			return words(about) && kept.length ? [{ about: words(about), kind: words(kind), facts: kept }] : [];
		}),
		relate: list("relate").flatMap((v) => {
			const { from, relation, to } = item(v);
			return words(from) && words(relation) && words(to) ? [{ from: words(from), relation: words(relation), to: words(to) }] : [];
		}),
		forget: list("forget").flatMap((v) => {
			const { about, fact } = item(v);
			return words(about) && words(fact) ? [{ about: words(about), fact: words(fact) }] : [];
		}),
	};
}

type Part = { type: string; text?: string };
const messageText = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? (content as Part[])
					.filter((part) => part.type === "text")
					.map((part) => part.text ?? "")
					.join("")
					.trim()
			: "";

const text = (value: unknown) => ({
	output: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }],
});

const bullets = (facts: readonly string[]) => facts.map((fact) => `- ${fact}`).join("\n");

export const graphMemory: MemorySystem = ({ dataDir, changed }) => {
	const file = join(dataDir, "memory.jsonl");
	const graph = new KnowledgeGraphManager(file);
	const find = (all: KnowledgeGraph, name: string) => all.entities.find((entity) => entity.name === name);

	/** What the agent knows before it recalls anything: itself, its person, and the names of everything else. */
	async function prompt(): Promise<string> {
		const all = await graph.readGraph();
		const self = find(all, SELF)?.observations ?? [];
		const user = find(all, USER)?.observations ?? [];
		const others = all.entities.filter((entity) => entity.name !== SELF && entity.name !== USER);
		const parts = [GUIDANCE];
		parts.push(self.length ? `What you remember about yourself:\n${bullets(self)}` : "You remember nothing about yourself yet.");
		parts.push(user.length ? `What you remember about the person:\n${bullets(user)}` : "You remember nothing about the person yet.");
		if (others.length) {
			const names = others.slice(0, NAMED).map((entity) => `${entity.name} (${entity.entityType})`);
			const more = others.length > NAMED ? `, and ${others.length - NAMED} more` : "";
			parts.push(`You also remember (recall them for what you know): ${names.join(", ")}${more}.`);
		}
		return parts.join("\n\n");
	}

	const remember = defineTool({
		name: "remember",
		description: `Remember lasting facts about someone or something: "${USER}" is the person you work for, "${SELF}" is you.`,
		parameters: obj({
			about: str({ description: `Who or what the facts are about: "${USER}", "${SELF}", or a name such as "Ola" or "Kraków trip".` }),
			kind: opt(str({ description: 'What sort of thing it is, for a new name: "person", "project", "place", "pet"…' })),
			facts: arr(str(), { description: "Short facts, one per item, such as \"Prefers mornings for calls\"." }),
		}),
		execute: async ({ about, kind, facts }) => {
			const name = about.trim();
			const added = await rememberFacts(name, kind, facts);
			changed();
			return text(added ? `Remembered ${added} new fact${added === 1 ? "" : "s"} about ${name}.` : `Already knew that about ${name}.`);
		},
	});

	/** Adds the facts to `name`, creating it as a `kind` when it is new; how many were new. */
	async function rememberFacts(name: string, kind: string | undefined, facts: readonly string[]): Promise<number> {
		const fallback = name === USER || name === SELF ? "person" : "thing";
		await graph.createEntities([{ name, entityType: kind?.trim() || fallback, observations: [] }]);
		const [result] = await graph.addObservations([{ entityName: name, contents: facts.map((fact) => fact.trim()).filter(Boolean) }]);
		return result?.addedObservations.length ?? 0;
	}

	/** The graph as reflection reads it: every entry with its facts and relations. */
	async function graphText(): Promise<string> {
		const all = await graph.readGraph();
		if (!all.entities.length) return "The graph is empty.";
		return all.entities
			.map((entity) => {
				const links = all.relations.filter((r) => r.from === entity.name).map((r) => `- ${r.relationType} → ${r.to}`);
				return [`${entity.name} (${entity.entityType})`, ...entity.observations.map((fact) => `- ${fact}`), ...links].join("\n");
			})
			.join("\n\n");
	}

	/** The run's exchange, what the person said and what the imp answered, in words; at most RUN_CHARS, newest kept. */
	async function exchange(runtime: TaskRuntime<Run, { phase: "reflect" }, null, object>, input: Run, context: Context) {
		const range = { minEntryId: input.first, maxEntryId: input.last, order: "ascending" } as const;
		const lines: string[] = [];
		let cursor: Parameters<typeof runtime.entries>[2];
		do {
			const page = await runtime.entries(range, 200, cursor, context);
			for (const entry of page.items) {
				const message = entry.model?.[0] as { role?: string; content?: unknown } | undefined;
				const said = messageText(message?.content);
				if (!said) continue;
				if (entry.kind === "pi.user") lines.push(`Person: ${said}`);
				else if (entry.kind === "pi.assistant") lines.push(`Imp: ${said}`);
			}
			cursor = page.next;
		} while (cursor !== undefined);
		const all = lines.join("\n\n");
		return all.length > RUN_CHARS ? all.slice(-RUN_CHARS) : all;
	}

	/** Applies what reflection found; whether anything changed. */
	async function apply(found: Reflection): Promise<boolean> {
		let changes = 0;
		for (const { about, fact } of found.forget) {
			changes += (await graph.deleteObservations([{ entityName: about, observations: [fact] }])).deletedCount;
		}
		for (const { about, kind, facts } of found.remember) changes += await rememberFacts(about, kind, facts);
		for (const { from, relation, to } of found.relate) {
			// A relation to something never remembered is dropped: the graph refuses it.
			changes += (await graph.createRelations([{ from, to, relationType: relation }]).catch(() => [])).length;
		}
		return changes > 0;
	}

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
					const said = await exchange(runtime, task.input, context);
					const ref = (await runtime.agent(context)).model;
					const model = ref && runtime.models.getModel(ref.provider, ref.modelId);
					if (said && model) {
						const answer = await runtime.models.completeSimple(
							model,
							{
								systemPrompt: REFLECT,
								messages: [
									{ role: "user", content: `What the graph holds now:\n\n${await graphText()}\n\nThe exchange:\n\n${said}`, timestamp: Date.now() },
								],
							},
							{ signal: runtime.signal },
						);
						if (answer.errorMessage) throw new Error(answer.errorMessage);
						if (await apply(readReflection(messageText(answer.content)))) changed();
					}
				} catch (error) {
					if (runtime.signal.aborted) throw error;
					// Memory is a nicety: a failed reflection forgets this run, it never fails anything else.
					console.error(`memory: reflecting on a run failed: ${error instanceof Error ? error.message : error}`);
				}
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
			},
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});

	/** Asked for by the run's afterRun hook, which waits for it: it only starts Reflect in the background, and ends. */
	const StartReflect = defineTask<Run, { phase: "start" }, null>({
		name: "memory.start-reflect",
		version: 1,
		initial: () => ({ phase: "start" }),
		phases: {
			start: (task, runtime, context) =>
				runtime.commit(async (tx) => {
					await tx.createTask(Reflect, task.input, { ownership: { kind: "conversation" }, background: true });
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, context),
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});

	const reflectAfterRuns = hook(GenerationTask, {
		afterRun: (run) => ({ tasks: [runEndTask(StartReflect, { first: run.first, last: run.last })] }),
	});

	const relate = defineTool({
		name: "relate",
		description: "Remember how two remembered things relate, such as user → works at → Acme. Remember both first.",
		parameters: obj({
			from: str(),
			relation: str({ description: 'In the active voice, such as "works at" or "has sister".' }),
			to: str(),
		}),
		execute: async ({ from, relation, to }) => {
			await graph.createRelations([{ from: from.trim(), to: to.trim(), relationType: relation.trim() }]);
			changed();
			return text(`Remembered: ${from} ${relation} ${to}.`);
		},
	});

	const recall = defineTool({
		name: "recall",
		description: "Search memory: everything remembered whose name, kind, or a fact contains the words, with its relations.",
		parameters: obj({ query: str({ description: "A name or a word, such as \"Ola\" or \"birthday\"." }) }),
		execute: async ({ query }) => {
			const found = await graph.searchNodes(query.trim(), { limit: 20 });
			return text(found.entities.length ? found : `Nothing in memory matches "${query}".`);
		},
	});

	const forget = defineTool({
		name: "forget",
		description: "Forget one fact about someone or something, or, without a fact, everything about them.",
		parameters: obj({ about: str(), fact: opt(str({ description: "The fact exactly as remembered." })) }),
		execute: async ({ about, fact }) => {
			await forgetEntry(about.trim(), fact);
			return text(fact ? `Forgot that about ${about}.` : `Forgot ${about}.`);
		},
	});

	async function forgetEntry(name: string, fact: string | undefined) {
		if (fact) await graph.deleteObservations([{ entityName: name, observations: [fact] }]);
		else await graph.deleteEntities([name]);
		changed();
	}

	const order = (entity: Entity) => (entity.name === SELF ? 0 : entity.name === USER ? 1 : 2);

	return {
		name: "Knowledge graph",
		location: file,
		extension: defineExtension({
			name: "memory",
			sections: [section("memory", () => prompt())],
			tools: [remember, relate, recall, forget],
			tasks: [StartReflect, Reflect],
			hooks: [reflectAfterRuns],
		}),
		async inspect(): Promise<MemoryEntry[]> {
			const all = await graph.readGraph();
			return [...all.entities]
				.sort((a, b) => order(a) - order(b))
				.map((entity) => ({
					id: entity.name,
					title: TITLES[entity.name] ?? entity.name,
					kind: entity.name in TITLES ? "" : entity.entityType,
					facts: entity.observations,
					links: all.relations
						.filter((relation) => relation.from === entity.name)
						.map((relation) => `${relation.relationType} → ${TITLES[relation.to] ?? relation.to}`),
				}));
		},
		forget: forgetEntry,
	};
};

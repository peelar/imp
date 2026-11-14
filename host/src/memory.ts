// The memory contract. The imp learns about its person as they talk and carries what it learned into every
// conversation. A memory system plugs in here: the knowledge graph in memory-graph.ts is the default, and another one
// (Mem0, Letta, Graphiti, a folder of Markdown notes) implements the same interface and is passed to startHost().
// Nothing else in the host knows which one runs.
//
// What every memory system guarantees:
// 1. What it keeps stays with the host (in `dataDir`, or a service only the host reaches), never on the agent's machine.
// 2. `changed()` is called after every write, by the agent or by the person, so open views refresh.
// 3. Everything it keeps is listed by `inspect()` and can be removed with `forget()`: the person sees what their imp
//    knows and has the last word on it.
import type { Extension } from "@earendil-works/pi-durable";

export const TOPIC = "memory";

export type MemoryProvider = {
  /** What Settings calls the system, such as "Knowledge graph". */
  readonly name: string;
  /** Where it keeps what it knows, in words for the person, such as the file's path. */
  readonly location: string;
  /**
   * The agent's side, selected in every conversation: tools that remember, recall, and forget, a prompt section with
   * what it already knows, and any hooks it needs (such as extracting memories after each run).
   */
  readonly extension: Extension;
  /** Everything remembered, as the person reads it. */
  readonly inspect: () => Promise<MemoryEntry[]>;
  /** The person forgets an entry, or one of its facts. */
  readonly forget: (entry: string, fact?: string) => Promise<void>;
};

export type MemoryEntry = {
  /** Stable within the system; forget() takes it. */
  readonly id: string;
  readonly title: string;
  /** What sort of thing it is ("person", "project", "preference"); "" when the system has no kinds. */
  readonly kind: string;
  readonly facts: readonly string[];
  /** How it relates to other entries, in words, such as "works at → Acme". */
  readonly links: readonly string[];
};

export type MemoryOptions = {
  /** The host's data directory. */
  readonly dataDir: string;
  /** Tells open views that memory changed. */
  readonly changed: () => void;
};

/** Builds a memory system; startHost() calls it once. */
export type MemorySystem = (options: MemoryOptions) => MemoryProvider;

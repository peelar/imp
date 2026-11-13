// Types for the part of @modelcontextprotocol/server-memory the default memory uses (the package ships JavaScript
// only). The knowledge graph file holds one JSON object per line: entities, then relations.
declare module "@modelcontextprotocol/server-memory/dist/index.js" {
	export interface Entity {
		name: string;
		entityType: string;
		observations: string[];
	}
	export interface Relation {
		from: string;
		to: string;
		relationType: string;
	}
	export interface KnowledgeGraph {
		entities: Entity[];
		relations: Relation[];
	}
	/** Every mutation reads the file, changes it, and replaces it atomically, one at a time, under a lock file. */
	export class KnowledgeGraphManager {
		constructor(memoryFilePath: string);
		/** Skips the entities whose names exist; returns the ones it created. */
		createEntities(entities: Entity[]): Promise<Entity[]>;
		/** Throws when an end is not an entity; skips relations that exist. */
		createRelations(relations: Relation[]): Promise<Relation[]>;
		/** Throws when an entity does not exist; skips observations it has. */
		addObservations(
			observations: { entityName: string; contents: string[] }[],
		): Promise<{ entityName: string; addedObservations: string[] }[]>;
		/** Also deletes the relations that touch them. */
		deleteEntities(entityNames: string[]): Promise<{ deleted: string[]; notFound: string[] }>;
		deleteObservations(
			deletions: { entityName: string; observations: string[] }[],
		): Promise<{ deletedCount: number; missingEntities: string[] }>;
		deleteRelations(relations: Relation[]): Promise<{ deletedCount: number }>;
		readGraph(): Promise<KnowledgeGraph>;
		/** Entities whose name, type, or an observation contains `query` (case-insensitive), and their relations. */
		searchNodes(query: string, options?: { limit?: number }): Promise<KnowledgeGraph>;
	}
}

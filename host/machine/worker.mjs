// One app's server code, in a worker of its own. The module's default export is the app (see sdk/app.ts); its
// database lives on the host, so every `app.db` call goes to the host and back.
import { parentPort, workerData } from "node:worker_threads";

const { appId, code } = workerData;
let nextId = 1;
const waiting = new Map();

function db(op, payload) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		waiting.set(id, { resolve, reject });
		parentPort.postMessage({ t: "db", id, op, ...payload });
	});
}

const app = Object.freeze({
	id: appId,
	db: Object.freeze({
		all: (sql, ...params) => db("all", { sql, params }),
		get: (sql, ...params) => db("get", { sql, params }),
		run: (sql, ...params) => db("run", { sql, params }),
		/** Runs the statements in one transaction: all of them or none. */
		batch: (statements) => db("batch", { statements }),
	}),
});

const errorText = (error) => (error instanceof Error ? error.message : String(error));

try {
	const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
	const definition = module.default ?? {};
	const sources = definition.sources ?? {};
	const mutations = definition.mutations ?? {};
	const tools = definition.tools ?? {};
	const manifest = {
		schema: definition.schema ?? [],
		sources: Object.keys(sources),
		mutations: Object.keys(mutations),
		tools: Object.entries(tools).map(([name, tool]) => ({
			name,
			description: String(tool.description ?? ""),
			params: tool.params ?? {},
		})),
	};
	const kinds = { source: sources, mutation: mutations, tool: tools };

	parentPort.on("message", async (message) => {
		if (message.t === "dbResult") {
			const w = waiting.get(message.id);
			waiting.delete(message.id);
			if (message.ok) w?.resolve(message.value);
			else w?.reject(new Error(message.error));
			return;
		}
		if (message.t !== "call") return;
		try {
			const entry = kinds[message.kind]?.[message.name];
			if (!entry) throw new Error(`${appId} has no ${message.kind} named ${message.name}`);
			const run = message.kind === "tool" ? entry.run : entry;
			const value = await run(message.args, app);
			parentPort.postMessage({ t: "result", id: message.id, ok: true, value: value ?? null });
		} catch (error) {
			parentPort.postMessage({ t: "result", id: message.id, ok: false, error: errorText(error) });
		}
	});
	parentPort.postMessage({ t: "ready", manifest });
} catch (error) {
	parentPort.postMessage({ t: "failed", error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
}

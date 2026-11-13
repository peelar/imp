// The Todos app's server code. It runs in a worker on the agent's machine; its database lives on the host.
import type { AppContext, AppServer, Json } from "../../../sdk/app.ts";

const list = (app: AppContext) =>
	app.db
		.all<{ id: number; title: string; done: number }>("SELECT id, title, done FROM todos ORDER BY id")
		.then((rows) => rows.map((row) => ({ id: String(row.id), title: row.title, done: row.done === 1 })));

const add = async (title: Json, app: AppContext) => {
	const text = String(title ?? "").trim();
	if (!text) return { ok: false, error: "A todo needs a title.", id: "" };
	const { lastInsertRowid } = await app.db.run("INSERT INTO todos (title) VALUES (?)", text);
	return { ok: true, error: "", id: String(lastInsertRowid) };
};

const setDone = async (id: Json, done: Json, app: AppContext) => {
	const { changes } = await app.db.run("UPDATE todos SET done = ? WHERE id = ?", done === true ? 1 : 0, Number(id));
	return changes > 0 ? { ok: true, error: "" } : { ok: false, error: `No todo with id ${id}.` };
};

const remove = async (id: Json, app: AppContext) => {
	const { changes } = await app.db.run("DELETE FROM todos WHERE id = ?", Number(id));
	return changes > 0 ? { ok: true, error: "" } : { ok: false, error: `No todo with id ${id}.` };
};

export default {
	schema: ["CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)"],
	sources: {
		list: (_args, app) => list(app),
	},
	mutations: {
		add: async ([title], app) => {
			const { ok, error } = await add(title, app);
			return { ok, error };
		},
		setDone: ([id, done], app) => setDone(id, done, app),
		remove: ([id], app) => remove(id, app),
	},
	tools: {
		todos_list: {
			description: "List every todo in the user's Todos app.",
			params: {},
			run: (_args, app) => list(app),
		},
		todos_add: {
			description: "Add a todo to the user's Todos app.",
			params: { title: { type: "string" } },
			run: ({ title }, app) => add(title, app),
		},
		todos_set_done: {
			description: "Mark a todo done or not done.",
			params: { id: { type: "string" }, done: { type: "boolean" } },
			run: ({ id, done }, app) => setDone(id, done, app),
		},
		todos_delete: {
			description: "Delete a todo. Deleting cannot be undone.",
			params: { id: { type: "string" } },
			run: ({ id }, app) => remove(id, app),
		},
	},
} satisfies AppServer;

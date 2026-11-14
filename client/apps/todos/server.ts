// The Todos app's server code. It runs in a worker on the agent's machine; its database lives on the host.
import type { AppServer, Json } from "../../../sdk/app.ts";

const isText = (value: Json | undefined): value is string =>
  typeof value === "string";

/** A text argument. The host checks every call against `params` first, so one declared a string is one. */
const textOf = (value: Json | undefined) => (isText(value) ? value : "");

export default {
  schema: [
    "CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)",
  ],
  operations: {
    list: {
      kind: "read",
      description:
        "List every todo, with its id, title and whether it is done.",
      params: {},
      run: async (_args, app) => {
        const rows = await app.db.all<{
          id: number;
          title: string;
          done: number;
        }>("SELECT id, title, done FROM todos ORDER BY id");

        return rows.map((row) => ({
          id: String(row.id),
          title: row.title,
          done: row.done === 1,
        }));
      },
    },
    add: {
      kind: "write",
      description: "Add a todo.",
      params: { title: { type: "string" } },
      run: async ({ title }, app) => {
        const text = textOf(title).trim();

        if (!text) {
          return { ok: false, error: "A todo needs a title." };
        }

        await app.db.run("INSERT INTO todos (title) VALUES (?)", text);

        return { ok: true, error: "" };
      },
    },
    setDone: {
      kind: "write",
      description: "Mark a todo done or not done.",
      params: { id: { type: "string" }, done: { type: "boolean" } },
      run: async ({ id, done }, app) => {
        const todo = textOf(id);

        const { changes } = await app.db.run(
          "UPDATE todos SET done = ? WHERE id = ?",
          done ? 1 : 0,
          Number(todo)
        );

        return changes > 0
          ? { ok: true, error: "" }
          : { ok: false, error: `No todo with id ${todo}.` };
      },
    },
    remove: {
      kind: "write",
      description: "Delete a todo. Deleting cannot be undone.",
      params: { id: { type: "string" } },
      run: async ({ id }, app) => {
        const todo = textOf(id);

        const { changes } = await app.db.run(
          "DELETE FROM todos WHERE id = ?",
          Number(todo)
        );

        return changes > 0
          ? { ok: true, error: "" }
          : { ok: false, error: `No todo with id ${todo}.` };
      },
    },
  },
} satisfies AppServer;

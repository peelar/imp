// A new app's server code: a list of notes to start from. Change it into the app the user asked for.
import type { AppServer } from "../sdk.ts";

export default {
  schema: ["CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL)"],
  operations: {
    notes: {
      kind: "read",
      description: "Every note, oldest first.",
      params: {},
      run: async (_args, app) => {
        const rows = await app.db.all<{ id: number; text: string }>(
          "SELECT id, text FROM notes ORDER BY id"
        );
        return rows.map((row) => ({ id: String(row.id), text: row.text }));
      },
    },
    addNote: {
      kind: "write",
      description: "Add a note.",
      params: { text: { type: "string" } },
      run: async ({ text }, app) => {
        const note = String(text).trim();
        if (!note) return { ok: false, error: "A note needs text." };
        await app.db.run("INSERT INTO notes (text) VALUES (?)", note);
        return { ok: true, error: "" };
      },
    },
  },
} satisfies AppServer;

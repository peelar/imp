// Each slot's data: one SQLite database on the host, which the slot's worker reads and writes through the app socket.
// The database's `user_version` counts the migrations it has had.
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { copyJson } from "@earendil-works/chord/json";
import { compile, int, obj } from "@earendil-works/pi-schema";
import type { Json, SqlValue } from "../../../sdk/app.ts";
import type { SqlRequest } from "./protocol.ts";

const userVersion = compile(obj({ user_version: int() }));
const changeCount = compile(obj({ n: int() }));

export type AppData = ReturnType<typeof openAppData>;

/** Whether the app has data in DATA_DIR/apps, where the gateway keeps it, before the gateway opens any. */
export const hasAppData = (dataDir: string, id: string) =>
  existsSync(path.join(dataDir, "apps", `${id}.sqlite`));

export function openAppData(dir: string) {
  mkdirSync(dir, { recursive: true });

  const file = (slot: string) => path.join(dir, `${slot}.sqlite`);
  const open = new Map<string, DatabaseSync>();

  const database = (slot: string) => {
    const existing = open.get(slot);

    if (existing) {
      return existing;
    }

    const db = new DatabaseSync(file(slot));

    open.set(slot, db);

    return db;
  };

  const close = (slot: string) => {
    open.get(slot)?.close();
    open.delete(slot);
  };

  const remove = (slot: string) => {
    close(slot);

    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(`${file(slot)}${suffix}`, { force: true });
    }
  };

  const schemaVersion = (slot: string) => {
    if (!existsSync(file(slot))) {
      return 0;
    }

    const row = database(slot).prepare("PRAGMA user_version").get();

    return userVersion.check(row) ? row.user_version : 0;
  };

  return {
    has: (slot: string) => existsSync(file(slot)),
    /** The migrations a slot's data has had. */
    schemaVersion,
    /** Applies the migrations of the `id` app that a slot's data has not had yet, all of them or none. */
    migrate(slot: string, id: string, schema: readonly string[]) {
      const db = database(slot);
      const version = schemaVersion(slot);

      if (version > schema.length) {
        throw new Error(
          `The ${id} app's data has ${version} migrations, but this version of the app has only ${schema.length}. Keep every migration and add new ones at the end.`
        );
      }

      if (version === schema.length) {
        return;
      }

      try {
        atomically(db, () => {
          for (const sql of schema.slice(version)) {
            db.exec(sql);
          }

          db.exec(`PRAGMA user_version = ${schema.length}`);
        });
      } catch (error) {
        throw new Error(
          `The ${id} app's migrations failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    },
    /** Answers a worker's request, and says whether it changed the data. */
    request(slot: string, request: SqlRequest) {
      const db = database(slot);
      const before = totalChanges(db);
      const value = answer(db, request);

      return { value, wrote: totalChanges(db) !== before };
    },
    /** Copies a slot's data to a file: a consistent copy even while the slot runs. No data copies as no file. */
    copyTo(slot: string, to: string) {
      rmSync(to, { force: true });

      if (existsSync(file(slot))) {
        database(slot).exec(`VACUUM INTO '${to.replaceAll("'", "''")}'`);
      }
    },
    /** Replaces a slot's data with a file's (none: empty data). The slot must not be running. */
    replace(slot: string, from: string | undefined) {
      remove(slot);

      if (from && existsSync(from)) {
        copyFileSync(from, file(slot));
      }
    },
    remove,
    close,
    closeAll() {
      for (const db of open.values()) {
        db.close();
      }

      open.clear();
    },
  };
}

/** Runs `work` in one transaction. */
function atomically<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN");

  try {
    const value = work();

    db.exec("COMMIT");

    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function answer(db: DatabaseSync, request: SqlRequest): Json {
  if (request.op === "batch") {
    return atomically(db, () =>
      request.statements.map((statement) =>
        run(db, statement.sql, statement.params ?? [])
      )
    );
  }

  if (request.op === "run") {
    return run(db, request.sql, request.params);
  }

  const statement = db.prepare(request.sql);

  const rows =
    request.op === "all"
      ? statement.all(...request.params)
      : (statement.get(...request.params) ?? null);

  try {
    // SQLite's rows have no prototype and may hold what JSON cannot; the copy is plain JSON or throws.
    return copyJson(rows);
  } catch (error) {
    throw new Error(
      "The query answered a value that is not a number, a text or null. Select a BLOB as text, such as hex(column).",
      { cause: error }
    );
  }
}

function run(db: DatabaseSync, sql: string, params: readonly SqlValue[]) {
  const result = db.prepare(sql).run(...params);

  return {
    changes: Number(result.changes),
    lastInsertRowid: Number(result.lastInsertRowid),
  };
}

function totalChanges(db: DatabaseSync) {
  const row = db.prepare("SELECT total_changes() AS n").get();

  return changeCount.check(row) ? row.n : 0;
}

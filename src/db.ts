import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initSchema } from "./schema";

// The schema, modes and settings helpers live in schema.ts so they run outside
// Bun; re-exported here so the CLI and tests keep importing from "./db".
export * from "./schema";
export type { Db, Stmt, SqlValue } from "./sqlite";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DB_PATH = process.env.JLPT_DB ?? join(ROOT, "data", "study.db");

export function openDb(path = DB_PATH): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  // Wait for a writer instead of failing. `import-sentences` holds the write
  // lock for ~1s, and the JSON `next`/`answer` flow is driven by a separate
  // process, so a concurrent grade() would otherwise throw "database is locked"
  // at the user — measured: 14 of 15 grades failed during one import.
  db.exec("PRAGMA busy_timeout = 5000;");
  initSchema(db);
  return db;
}

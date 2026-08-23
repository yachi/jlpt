import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DB_PATH = process.env.JLPT_DB ?? join(ROOT, "data", "study.db");

/** Question modes. Each (item, mode) pair is scheduled as its own FSRS card. */
export const MODES = ["meaning", "reading", "listening", "production"] as const;
export type Mode = (typeof MODES)[number];

/** Which JLPT scoring section each mode feeds, per jlpt.jp scoring sections. */
export const MODE_SECTION: Record<Mode, "knowledge" | "listening"> = {
  meaning: "knowledge",
  reading: "knowledge",
  listening: "listening",
  production: "knowledge",
};

export function openDb(path = DB_PATH): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id          INTEGER PRIMARY KEY,
      level       TEXT NOT NULL,               -- 'N5' | 'N4'
      expression  TEXT NOT NULL,
      reading     TEXT NOT NULL,
      meaning     TEXT NOT NULL,
      has_kanji   INTEGER NOT NULL DEFAULT 0,
      UNIQUE (level, expression, reading)
    );

    CREATE TABLE IF NOT EXISTS cards (
      item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      mode        TEXT    NOT NULL,
      stability   REAL,
      difficulty  REAL,
      state       TEXT    NOT NULL DEFAULT 'learning',
      step        INTEGER,
      due         INTEGER NOT NULL,            -- epoch ms
      last_review INTEGER,
      introduced  INTEGER NOT NULL DEFAULT 0,  -- 0 = still in the new queue
      PRIMARY KEY (item_id, mode)
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id   INTEGER NOT NULL,
      mode      TEXT    NOT NULL,
      rating    INTEGER NOT NULL,
      correct   INTEGER NOT NULL,
      ts        INTEGER NOT NULL,
      elapsed_ms INTEGER
    );

    CREATE TABLE IF NOT EXISTS exams (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      level     TEXT NOT NULL,
      ts        INTEGER NOT NULL,
      knowledge_score INTEGER NOT NULL,
      knowledge_max   INTEGER NOT NULL,
      listening_score INTEGER NOT NULL,
      listening_max   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);

    -- Words whose kanji actively mislead a Chinese/Cantonese reader.
    -- These keep their meaning card even when skip_meaning_for_kanji is on.
    CREATE TABLE IF NOT EXISTS false_friends (expression TEXT PRIMARY KEY);

    CREATE INDEX IF NOT EXISTS idx_cards_due  ON cards(introduced, due);
    CREATE INDEX IF NOT EXISTS idx_reviews_ts ON reviews(ts);
    -- nextQuestion() runs a correlated "when did I last see this word?" subquery
    -- per candidate row for the sibling cooldown. Without this index that is a
    -- full scan of reviews on every single call, and reviews grows forever.
    CREATE INDEX IF NOT EXISTS idx_reviews_item ON reviews(item_id, ts);
    CREATE INDEX IF NOT EXISTS idx_reviews_item_mode_id ON reviews(item_id, mode, id);
  `);
  return db;
}

export function getSetting(db: Database, k: string, fallback: string): string {
  const row = db.query<{ v: string }, [string]>("SELECT v FROM settings WHERE k = ?").get(k);
  return row?.v ?? fallback;
}

export function setSetting(db: Database, k: string, v: string): void {
  db.query("INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
}

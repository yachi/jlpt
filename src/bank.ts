import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { ROOT, MODES } from "./db";

export interface Item {
  id: number;
  level: string;
  expression: string;
  reading: string;
  meaning: string;
  has_kanji: number;
}

const KANJI_RE = /[一-鿿㐀-䶿]/;

/** Minimal RFC-4180 CSV parser (handles quoted fields containing commas). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Load the N5/N4 vocabulary CSVs into `items`, and create one FSRS card per
 * (item, mode). Idempotent — safe to re-run.
 *
 * Data: github.com/jamsinclair/open-anki-jlpt-decks (MIT), itself derived from
 * tanos.co.uk lists, which reconstruct the withdrawn 2004 JLPT 出題基準.
 * These lists are UNOFFICIAL: JLPT has published no syllabus since 2010.
 */
export async function seed(db: Database, now = Date.now()): Promise<{ items: number; cards: number }> {
  const insItem = db.query(
    `INSERT INTO items (level, expression, reading, meaning, has_kanji) VALUES (?,?,?,?,?)
     ON CONFLICT(level, expression, reading) DO NOTHING`,
  );
  const insCard = db.query(
    `INSERT INTO cards (item_id, mode, due, introduced) VALUES (?,?,?,0)
     ON CONFLICT(item_id, mode) DO NOTHING`,
  );

  const tx = db.transaction((rows: { level: string; cells: string[] }[]) => {
    for (const { level, cells } of rows) {
      const [expression, reading, meaning] = cells;
      if (!expression || !reading || !meaning) continue;
      insItem.run(level, expression, reading, meaning, KANJI_RE.test(expression) ? 1 : 0);
    }
  });

  const all: { level: string; cells: string[] }[] = [];
  for (const level of ["N5", "N4"] as const) {
    const file = Bun.file(join(ROOT, "data", `${level.toLowerCase()}.csv`));
    if (!(await file.exists())) throw new Error(`Missing data/${level.toLowerCase()}.csv — run: bun run cli fetch-data`);
    const rows = parseCsv(await file.text());
    for (const cells of rows.slice(1)) if (cells.length >= 3) all.push({ level, cells });
  }
  tx(all);

  await loadFalseFriends(db);

  const items = db.query<Item, []>("SELECT * FROM items").all();
  const cardTx = db.transaction(() => {
    for (const it of items) {
      for (const mode of MODES) {
        // 'reading' only makes sense for words actually written with kanji.
        if (mode === "reading" && !it.has_kanji) continue;
        insCard.run(it.id, mode, now);
      }
    }
  });
  cardTx();

  const cards = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM cards").get()!.n;
  return { items: items.length, cards };
}

/**
 * Load data/false-friends.txt into the `false_friends` table.
 * Format: one expression per line; `#` starts a comment; blanks ignored.
 * Entries that don't match any item are reported, so typos surface instead of
 * silently doing nothing.
 */
export async function loadFalseFriends(db: Database): Promise<{ loaded: number; unmatched: string[] }> {
  const file = Bun.file(join(ROOT, "data", "false-friends.txt"));
  if (!(await file.exists())) return { loaded: 0, unmatched: [] };

  const expressions = (await file.text())
    .split("\n")
    .map((line) => line.split("#")[0]!.trim())
    .filter(Boolean);

  const ins = db.query("INSERT INTO false_friends (expression) VALUES (?) ON CONFLICT DO NOTHING");
  db.transaction(() => { for (const e of expressions) ins.run(e); })();

  const unmatched = expressions.filter(
    (e) => !db.query("SELECT 1 FROM items WHERE expression = ?").get(e),
  );
  return { loaded: expressions.length, unmatched };
}

/**
 * First English gloss only — CSV meanings are comma-joined lists.
 * Separators inside brackets don't count, otherwise a gloss like
 * "to dial/call (e.g., a telephone number)" gets truncated to "to dial/call (e.g."
 */
export function shortMeaning(meaning: string): string {
  let depth = 0;
  for (let i = 0; i < meaning.length; i++) {
    const ch = meaning[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if ((ch === "," || ch === ";") && depth === 0) {
      const head = meaning.slice(0, i).trim();
      if (head) return head;
    }
  }
  return meaning.trim();
}

/**
 * Pick `n` distractors for an item. Distractors are drawn from the same JLPT
 * level so difficulty stays calibrated, and (for readings) biased toward the
 * same length and first mora so the question can't be solved by shape alone.
 */
export function distractors(
  db: Database,
  target: Item,
  field: "meaning" | "reading",
  n: number,
  rng: () => number = Math.random,
): string[] {
  const targetVal = field === "meaning" ? shortMeaning(target.meaning) : target.reading;
  const pool = db
    .query<Item, [string, number]>(`SELECT * FROM items WHERE level = ? AND id != ? `)
    .all(target.level, target.id);

  const score = (c: Item) => {
    if (field === "reading") {
      let s = 0;
      if (c.reading.length === target.reading.length) s += 2;
      if (c.reading[0] === target.reading[0]) s += 1;
      if (c.has_kanji === target.has_kanji) s += 1;
      return s;
    }
    return 0;
  };

  const seen = new Set<string>([targetVal.toLowerCase()]);
  const candidates = pool
    .map((c) => ({ c, key: score(c) + rng() }))
    .sort((a, b) => b.key - a.key)
    .map(({ c }) => (field === "meaning" ? shortMeaning(c.meaning) : c.reading));

  const out: string[] = [];
  for (const v of candidates) {
    const k = v.toLowerCase();
    if (!v || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
    if (out.length === n) break;
  }
  return out;
}

import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { ROOT, MODES, getSetting, setSetting } from "./db";

/** settings key holding the bank identity the loaded sentence links belong to. */
export const BANK_FINGERPRINT_KEY = "bank_fingerprint";

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
/**
 * Deliberate overrides of a gloss that is wrong in the upstream CSV.
 *
 * The CSVs are the external oracle for this bank and are never regenerated from
 * code -- but an upstream row can simply be wrong, and shipping it teaches the
 * learner the wrong thing. data/gloss-corrections.csv is the documented escape
 * hatch: one row per override, carrying the value it replaces so the override
 * can be checked rather than trusted.
 *
 * Each row is `level,expression,reading,was,now,why`. `was` is the assertion:
 * if the CSV no longer says it, the upstream row changed under us and the
 * correction is reported as stale instead of being applied blindly -- otherwise
 * a fixed upstream would be silently re-broken by a correction nobody re-read.
 *
 * Gloss is not part of bankFingerprint() (which hashes id/level/expression/
 * reading), so correcting one does NOT invalidate the sentence links.
 */
export async function applyGlossCorrections(
  db: Database,
): Promise<{ applied: number; stale: string[]; missing: string[] }> {
  const file = Bun.file(join(ROOT, "data", "gloss-corrections.csv"));
  if (!(await file.exists())) return { applied: 0, stale: [], missing: [] };

  const get = db.query<{ id: number; meaning: string }, [string, string, string]>(
    "SELECT id, meaning FROM items WHERE level = ? AND expression = ? AND reading = ?");
  const upd = db.query("UPDATE items SET meaning = ? WHERE id = ?");

  let applied = 0;
  const stale: string[] = [], missing: string[] = [];
  // Skip `#` comments and the header by NAME, not by position: the file leads
  // with a comment block explaining how to revise a correction, so slicing off
  // "the first row" would drop a comment and feed the header in as data.
  for (const cells of parseCsv(await file.text())) {
    if (cells.length < 5) continue;
    const first = cells[0]!.trim();
    if (first.startsWith("#") || first.toLowerCase() === "level") continue;
    const [level, expression, reading, was, now] = cells as [string, string, string, string, string];
    const row = get.get(level, expression, reading);
    if (!row) { missing.push(`${expression}【${reading}】`); continue; }
    if (row.meaning === now) continue;                 // already applied
    if (row.meaning !== was) { stale.push(`${expression}【${reading}】: expected "${was}", found "${row.meaning}"`); continue; }
    upd.run(now, row.id);
    applied++;
  }
  return { applied, stale, missing };
}

export async function seed(
  db: Database, now = Date.now(),
): Promise<{ items: number; cards: number; droppedSentences: number;
  corrections: { applied: number; stale: string[]; missing: string[] } }> {
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

  // Overrides run AFTER the insert: insItem is ON CONFLICT DO NOTHING, so an
  // existing row's gloss is never updated by re-seeding.
  const corrections = await applyGlossCorrections(db);

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

  // If the bank's identity changed, every sentence_items row now names a
  // DIFFERENT word than the corpus meant. Those links cannot be repaired --
  // only rebuilt -- and leaving them is worse than having none: the learner
  // would be asked the meaning of a word that is not in the audio. Drop them
  // and say so; `cli import-sentences` puts them back.
  const fingerprint = bankFingerprint(db);
  let droppedSentences = 0;
  if (getSetting(db, BANK_FINGERPRINT_KEY, "") !== fingerprint) {
    droppedSentences = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sentences").get()!.n;
    if (droppedSentences > 0) db.exec("DELETE FROM sentence_items; DELETE FROM sentences;");
    setSetting(db, BANK_FINGERPRINT_KEY, fingerprint);
  }

  return { items: items.length, cards, droppedSentences, corrections };
}

/**
 * A hash of the bank's IDENTITY: which id names which word.
 *
 * data/sentences.json keys every word by item id, and ids are assigned by the
 * INSERT order in seed(). Insert the same CSVs in a different order -- or seed
 * once, add a CSV row, and seed again, where ON CONFLICT DO NOTHING gives the
 * late arrival an id at the END -- and every id after that point names a
 * different word. Measured on a bank re-seeded after one row was inserted at
 * CSV position 200: 1184 of 1384 ids resolved to a different word, and the
 * corpus still imported cleanly because every id still EXISTED.
 *
 * `meaning` is deliberately excluded: editing a gloss does not change which
 * word an id names, and should not invalidate a corpus.
 */
export function bankFingerprint(db: Database): string {
  const h = new Bun.CryptoHasher("sha256");
  for (const r of db.query<{ id: number; level: string; expression: string; reading: string }, []>(
    "SELECT id, level, expression, reading FROM items ORDER BY id").all()) {
    h.update(`${r.id}|${r.level}|${r.expression}|${r.reading}\n`);
  }
  return h.digest("hex");
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
 * Split a CSV meaning into its top-level English glosses.
 *
 * Separators inside brackets don't count, otherwise a gloss like
 * "to dial/call (e.g., a telephone number)" splits at the wrong comma.
 */
export function glossClauses(meaning: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < meaning.length; i++) {
    const ch = meaning[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if ((ch === "," || ch === ";") && depth === 0) {
      const head = meaning.slice(start, i).trim();
      if (head) out.push(head);
      start = i + 1;
    }
  }
  const tail = meaning.slice(start).trim();
  if (tail) out.push(tail);
  return out.length ? out : [meaning.trim()];
}

/** First English gloss only. The k=1 case of glossClauses(). */
export function shortMeaning(meaning: string): string {
  return glossClauses(meaning)[0]!;
}

/**
 * The gloss to SHOW for an item: the shortest run of leading clauses that no
 * other word in the bank shares.
 *
 * The first clause alone is not enough. Measured over the bank, 157 of 1384
 * items (11.3%) shared their first clause with a different word, and in 127 of
 * those the source did distinguish them — the truncation threw the distinction
 * away. 薄い "thin, weak" and 細い "thin, slender, fine" both showed **thin**;
 * うち "home; house; my place" and 家庭 "home; family" both showed **home**;
 * こんな "such, like this" and そんな "such, like that" both showed **such**.
 * The card was answerable, but what it taught did not identify the word.
 * Escalating drops that to 34 items (2.5%).
 *
 * Deterministic per item, and used for BOTH the answer and the distractors:
 * escalating only the answer would make the longest option the correct one.
 *
 * The 34 that remain have genuinely identical source glosses — 赤/赤い both
 * "red", ええ/はい both "yes", 明日 read あした or あす. No gloss can separate
 * those; productionPrompt() tags the part of speech and accepts the rest.
 */
export function displayGloss(db: Database, item: { meaning: string }): string {
  return glossIndex(db).display(item.meaning);
}

/**
 * How many bank items share each leading-clause prefix.
 *
 * Cached per database: building it costs ~0.95 ms against 1384 items, which
 * would be a 2.3x regression on nextQuestion's 0.74 ms. The stamp query is
 * 0.069 ms. It counts rows and total gloss length, so it misses only an edit
 * that preserves both — meanings are written by seed() and
 * applyGlossCorrections() alone, and neither can do that.
 */
export interface GlossIndex {
  /** The shortest run of leading clauses that no other item shares. */
  display(meaning: string): string;
  /** Ids of every OTHER item that ends up showing the same gloss. */
  sharing(gloss: string, exceptId: number): number[];
}

const glossCache = new WeakMap<Database, { stamp: string; index: GlossIndex }>();

/**
 * Fetch the index ONCE per call site, not once per item.
 *
 * The stamp query is only 0.069 ms, but productionPrompt compares the target
 * against every other item and distractors() renders a pool of ~700 — calling
 * displayGloss() per row made the full-bank production test issue ~1.9M stamp
 * queries and run for over two minutes. `sharing()` exists so productionPrompt
 * is one lookup instead of 1383 comparisons.
 */
export function glossIndex(db: Database): GlossIndex {
  const s = db.query<{ n: number; len: number }, []>(
    "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(meaning)), 0) AS len FROM items").get()!;
  const stamp = `${s.n}:${s.len}`;
  const hit = glossCache.get(db);
  if (hit?.stamp === stamp) return hit.index;

  const rows = db.query<{ id: number; meaning: string }, []>("SELECT id, meaning FROM items").all();
  const counts = new Map<string, number>();
  for (const r of rows) {
    const cl = glossClauses(r.meaning);
    for (let k = 1; k <= cl.length; k++) {
      const p = cl.slice(0, k).join(", ").toLowerCase();
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
  }
  const display = (meaning: string): string => {
    const cl = glossClauses(meaning);
    for (let k = 1; k <= cl.length; k++) {
      const p = cl.slice(0, k).join(", ");
      if (counts.get(p.toLowerCase()) === 1) return p;
    }
    return meaning.trim();
  };
  const byDisplay = new Map<string, number[]>();
  for (const r of rows) {
    const k = display(r.meaning).toLowerCase();
    (byDisplay.get(k) ?? byDisplay.set(k, []).get(k)!).push(r.id);
  }
  const index: GlossIndex = {
    display,
    sharing: (gloss, exceptId) =>
      (byDisplay.get(gloss.toLowerCase()) ?? []).filter((id) => id !== exceptId),
  };
  glossCache.set(db, { stamp, index });
  return index;
}

/**
 * The prompt for a production card, and the readings it must also accept.
 *
 * A production card shows a gloss and asks for the reading, so the gloss has to
 * determine the answer. The first clause alone does not: 76 short glosses named
 * more than one bank entry, making 161 of 1384 production cards (11.6%)
 * unanswerable — "red" is both 赤【あか】and 赤い【あかい】, and no amount of
 * knowing Japanese picks one. Found live, marking a correct answer wrong.
 *
 * Two layers now, because displayGloss() absorbed the first one. It already
 * returns the shortest gloss unique in the bank, so a prompt is ambiguous here
 * only when NO gloss can separate the words — 34 of 1384 items:
 *   1. an い-adjective tag, derived structurally (same expression and reading
 *      as another entry plus い) — resolves the noun/adjective pairs, which no
 *      gloss can separate because both really do mean "red"
 *   2. whatever is still tied is a genuine synonym set (あした/あす,
 *      在る/有る, ええ/はい): accept every member's reading, since the question
 *      as posed has more than one correct answer.
 *
 * Layer 2 is the guarantee; layer 1 exists so the card still teaches something.
 */
export function productionPrompt(
  db: Database, item: Item,
): { prompt: string; alsoAccept: string[] } {
  const gi = glossIndex(db);
  const gloss = gi.display(item.meaning);
  const tiedIds = gi.sharing(gloss, item.id);
  if (tiedIds.length === 0) return { prompt: gloss, alsoAccept: [] };
  const stillTied = db
    .query<Item, []>(`SELECT * FROM items WHERE id IN (${tiedIds.join(",")})`).all();

  // An い-adjective and the noun it is built on: 赤い/赤, 青い/青, 黄色い/黄色.
  const adjectiveOf = (a: Item, b: Item) =>
    a.expression === `${b.expression}い` && a.reading === `${b.reading}い`;
  const isAdjective = stillTied.some((c) => adjectiveOf(item, c));
  const isBaseNoun = stillTied.some((c) => adjectiveOf(c, item));
  const remaining = stillTied.filter((c) => !adjectiveOf(item, c) && !adjectiveOf(c, item));

  const prompt = isAdjective ? `${gloss} (い-adjective)`
    : isBaseNoun ? `${gloss} (noun)`
    : gloss;
  return { prompt, alsoAccept: remaining.map((c) => c.reading) };
}

/**
 * Pick `n` distractors for an item. Distractors are drawn from the same JLPT
 * level so difficulty stays calibrated, and (for readings) biased toward the
 * same length and first mora so the question can't be solved by shape alone.
 *
 * `exclude` bars specific answer VALUES, not item ids: two different bank
 * entries can share a gloss, so excluding by id would still let the same
 * English through under a different word. The caller that needs this is
 * sentence listening -- with a sentence stimulus, a distractor that glosses
 * some OTHER word in the sentence is something the learner genuinely heard,
 * and perfect comprehension would grade as Again.
 */
/**
 * Glosses of every OTHER bank item that shares this item's reading.
 *
 * A listening card plays the reading alone, so nothing in the stimulus can
 * separate 暑い / 熱い / 厚い (all あつい). If a rival's gloss is offered as a
 * distractor, TWO options are correct for what was played and one of them
 * grades as Again. Measured over 20,000 built questions on the 100 items whose
 * reading is shared: 31 (0.15%) had a second correct option, spread over 39
 * items and peaking at 1.6% for 日【ひ】 against 火【ひ】.
 *
 * Only listening needs this. `meaning` and `reading` cards put the expression
 * on screen, which is exactly what tells the homophones apart -- there a
 * rival's gloss is the most instructive distractor in the bank, not a bug.
 */
export function homophoneGlosses(db: Database, item: Item): string[] {
  return db
    .query<{ meaning: string }, [string, number]>(
      "SELECT meaning FROM items WHERE reading = ? AND id != ?")
    .all(item.reading, item.id)
    .map((r) => glossIndex(db).display(r.meaning));
}

export function distractors(
  db: Database,
  target: Item,
  field: "meaning" | "reading",
  n: number,
  rng: () => number = Math.random,
  exclude: Iterable<string> = [],
): string[] {
  const gi = field === "meaning" ? glossIndex(db) : null;
  const targetVal = gi ? gi.display(target.meaning) : target.reading;
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
  for (const e of exclude) seen.add(e.toLowerCase());
  const candidates = pool
    .map((c) => ({ c, key: score(c) + rng() }))
    .sort((a, b) => b.key - a.key)
    .map(({ c }) => (gi ? gi.display(c.meaning) : c.reading));

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

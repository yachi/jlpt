import type { Database } from "bun:sqlite";
import { Scheduler, newCard, type Card, type Rating } from "./fsrs";
import { distractors, shortMeaning, type Item } from "./bank";
import { MODES, MODE_SECTION, getSetting, type Mode } from "./db";

export const scheduler = new Scheduler();

/** How long to wait before introducing another mode of the same word. */
export const SIBLING_COOLDOWN_MS = 20 * 60 * 60 * 1000; // 20h — i.e. "not the same day"

export interface Question {
  itemId: number;
  mode: Mode;
  level: string;
  /** Human-readable instruction. */
  instruction: string;
  /** Text shown on screen. Empty for listening (audio only). */
  prompt: string;
  /**
   * Kana reading shown alongside the prompt. Set ONLY for `meaning` cards —
   * on `reading` it is the answer, and on `production` it is what you must type.
   */
  promptReading?: string;
  /** Japanese to synthesize, if this question has audio. */
  audioText?: string;
  /** MC options; empty for typed production. */
  choices: string[];
  answerIndex: number;
  /** Correct answer as text (for typed grading + feedback). */
  answer: string;
  /** Shown after answering. */
  reveal: string;
  isNew: boolean;
  section: "knowledge" | "listening";
}

interface CardRow {
  item_id: number; mode: Mode; stability: number | null; difficulty: number | null;
  state: string; step: number | null; due: number; last_review: number | null; introduced: number;
}

function toCard(r: CardRow): Card {
  return {
    stability: r.stability, difficulty: r.difficulty,
    state: r.state as Card["state"], step: r.step,
    due: r.due, lastReview: r.last_review,
  };
}

export function dueCount(db: Database, now = Date.now()) {
  const due = db.query<{ n: number }, [number]>(
    "SELECT COUNT(*) AS n FROM cards WHERE introduced = 1 AND due <= ?").get(now)!.n;
  const learned = db.query<{ n: number }, []>(
    "SELECT COUNT(*) AS n FROM cards WHERE introduced = 1").get()!.n;
  const total = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM cards").get()!.n;
  return { due, learned, total, unseen: total - learned };
}

function newIntroducedToday(db: Database, now = Date.now()): number {
  const startOfDay = new Date(now).setHours(0, 0, 0, 0);
  return db.query<{ n: number }, [number]>(
    `SELECT COUNT(DISTINCT item_id || ':' || mode) AS n FROM reviews
     WHERE ts >= ? AND id IN (SELECT MIN(id) FROM reviews GROUP BY item_id, mode)`,
  ).get(startOfDay)!.n;
}

export interface NextOptions {
  level?: "N5" | "N4" | "both";
  mode?: Mode | "any";
  now?: number;
  rng?: () => number;
  /** Override the configured daily new-card limit. */
  newLimit?: number;
}

/**
 * Pick the next card: most-overdue review first, otherwise introduce a new card
 * if under today's new limit. Returns null when nothing is due.
 */
export function nextQuestion(db: Database, opts: NextOptions = {}): Question | null {
  const now = opts.now ?? Date.now();
  const rng = opts.rng ?? Math.random;
  const level = opts.level ?? "both";
  const mode = opts.mode ?? "any";
  const newLimit = opts.newLimit ?? Number.parseInt(getSetting(db, "new_per_day", "5"), 10);

  const levelSql = level === "both" ? "" : " AND i.level = ?";
  const modeSql = mode === "any" ? "" : " AND c.mode = ?";
  const params: (string | number)[] = [];
  if (level !== "both") params.push(level);
  if (mode !== "any") params.push(mode);

  let row = db.query<CardRow & Item, any[]>(
    `SELECT c.*, i.level, i.expression, i.reading, i.meaning, i.has_kanji
       FROM cards c JOIN items i ON i.id = c.item_id
      WHERE c.introduced = 1 AND c.due <= ?${levelSql}${modeSql}
      ORDER BY c.due ASC LIMIT 1`,
  ).get(now, ...params) as (CardRow & Item) | null;

  let isNew = false;
  if (!row && newIntroducedToday(db, now) < newLimit) {
    isNew = true;
    // Introduce easiest-first: N5 before N4, and within a level, in list order.
    // Don't introduce a second mode of a word you just saw: answering 「ああ」as
    // listening 30s after seeing it as text tests short-term memory, not the word.
    // Siblings are deprioritised (not banned) until SIBLING_COOLDOWN_MS has passed.
    const cutoff = now - SIBLING_COOLDOWN_MS;
    row = db.query<CardRow & Item, any[]>(
      `SELECT c.*, i.level, i.expression, i.reading, i.meaning, i.has_kanji
         FROM cards c JOIN items i ON i.id = c.item_id
        WHERE c.introduced = 0${levelSql}${modeSql}
        ORDER BY COALESCE((SELECT MAX(r.ts) FROM reviews r WHERE r.item_id = c.item_id), 0) > ? ASC,
                 CASE i.level WHEN 'N5' THEN 0 ELSE 1 END, c.item_id ASC,
                 CASE c.mode WHEN 'meaning' THEN 0 WHEN 'reading' THEN 1
                             WHEN 'listening' THEN 2 ELSE 3 END
        LIMIT 1`,
      // NOTE: positional `?` bind in SQL text order — the WHERE params come
      // before the ORDER BY cutoff, so `cutoff` must go LAST.
    ).get(...params, cutoff) as (CardRow & Item) | null;
  }
  if (!row) return null;

  const item: Item = {
    id: row.item_id, level: row.level, expression: row.expression,
    reading: row.reading, meaning: row.meaning, has_kanji: row.has_kanji,
  };
  return buildQuestion(db, item, row.mode, isNew, rng);
}

function shuffleWithAnswer(answer: string, wrong: string[], rng: () => number) {
  const all = [answer, ...wrong];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [all[i], all[j]] = [all[j]!, all[i]!];
  }
  return { choices: all, answerIndex: all.indexOf(answer) };
}

export function buildQuestion(
  db: Database, item: Item, mode: Mode, isNew: boolean, rng: () => number = Math.random,
): Question {
  const meaning = shortMeaning(item.meaning);
  const base = {
    itemId: item.id, mode, level: item.level, isNew,
    section: MODE_SECTION[mode],
    reveal: `${item.expression}【${item.reading}】— ${item.meaning}`,
  };

  switch (mode) {
    case "meaning": {
      const { choices, answerIndex } = shuffleWithAnswer(meaning, distractors(db, item, "meaning", 3, rng), rng);
      return { ...base, instruction: "What does this mean?", prompt: item.expression,
        // Safe here: this card tests meaning, so the reading is a hint, not the answer.
        promptReading: item.reading === item.expression ? undefined : item.reading,
        audioText: item.expression, choices, answerIndex, answer: meaning };
    }
    case "reading": {
      const { choices, answerIndex } = shuffleWithAnswer(item.reading, distractors(db, item, "reading", 3, rng), rng);
      return { ...base, instruction: "How is this read? (漢字読み)", prompt: item.expression,
        choices, answerIndex, answer: item.reading };
    }
    case "listening": {
      const { choices, answerIndex } = shuffleWithAnswer(meaning, distractors(db, item, "meaning", 3, rng), rng);
      return { ...base, instruction: "Listen, then choose the meaning. (聴解)", prompt: "",
        audioText: item.expression, choices, answerIndex, answer: meaning };
    }
    case "production": {
      return { ...base, instruction: "Type the Japanese reading (kana).", prompt: meaning,
        choices: [], answerIndex: -1, answer: item.reading };
    }
  }
}

/** Normalize typed input: NFKC, strip whitespace and the ~ placeholder used in the lists. */
export function normalize(s: string): string {
  return s.normalize("NFKC").replace(/[\s　～~]/g, "").toLowerCase();
}

export function checkAnswer(q: Question, response: string | number): boolean {
  if (q.mode === "production") {
    const given = normalize(String(response));
    // Accept the kana reading or the written form (an IME user may type either).
    const item = q.reveal.match(/^(.+?)【(.+?)】/);
    return given === normalize(q.answer) || (item ? given === normalize(item[1]!) : false);
  }
  return Number(response) === q.answerIndex;
}

/**
 * Map a graded response onto an FSRS rating.
 *   wrong                -> 1 Again
 *   right but slow (>12s) -> 2 Hard
 *   right                -> 3 Good
 * Rating 4 (Easy) is reserved for an explicit user override, so that ordinary
 * correct answers don't inflate intervals.
 */
export function ratingFor(correct: boolean, elapsedMs: number, easyOverride = false): Rating {
  if (!correct) return 1;
  if (easyOverride) return 4;
  return elapsedMs > 12_000 ? 2 : 3;
}

export interface GradeResult {
  correct: boolean; rating: Rating; answer: string; reveal: string;
  nextDue: number; intervalHuman: string; stability: number | null; retrievability: number;
}

export function grade(
  db: Database, q: Question, response: string | number, elapsedMs = 0,
  opts: { now?: number; easy?: boolean; rng?: () => number } = {},
): GradeResult {
  const now = opts.now ?? Date.now();
  const correct = checkAnswer(q, response);
  const rating = ratingFor(correct, elapsedMs, opts.easy);

  const row = db.query<CardRow, [number, string]>(
    "SELECT * FROM cards WHERE item_id = ? AND mode = ?").get(q.itemId, q.mode);
  const before: Card = row && row.introduced === 1 ? toCard(row) : newCard(now);
  const after = scheduler.review(before, rating, now, opts.rng ?? Math.random);

  db.query(
    `UPDATE cards SET stability=?, difficulty=?, state=?, step=?, due=?, last_review=?, introduced=1
      WHERE item_id=? AND mode=?`,
  ).run(after.stability, after.difficulty, after.state, after.step, after.due, after.lastReview, q.itemId, q.mode);

  db.query(
    "INSERT INTO reviews (item_id, mode, rating, correct, ts, elapsed_ms) VALUES (?,?,?,?,?,?)",
  ).run(q.itemId, q.mode, rating, correct ? 1 : 0, now, elapsedMs);

  return {
    correct, rating, answer: q.answer, reveal: q.reveal,
    nextDue: after.due, intervalHuman: humanInterval(after.due - now),
    stability: after.stability, retrievability: scheduler.retrievability(after, now),
  };
}

export function humanInterval(ms: number): string {
  const m = ms / 60_000;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)}d`;
  if (d < 365) return `${(d / 30.4).toFixed(1)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}

export { MODES };

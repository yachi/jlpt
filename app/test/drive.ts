/**
 * A scripted study session over the REAL core, against any `Db`.
 *
 * Shared by the sql.js tests (run by Node through tsx) and bun-reference.ts
 * (run by Bun on bun:sqlite), so "the adapter behaves like bun:sqlite" is
 * checked by running the same code on both engines and comparing transcripts,
 * not by restating what the answers ought to be.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BankFiles } from "../../src/bank";
import { bankFingerprint } from "../../src/bank";
import { DONT_KNOW, dueCount, grade, introduceCard, nextQuestion, type Question } from "../../src/quiz";
import type { Db } from "../../src/sqlite";

const DATA = new URL("../../data/", import.meta.url);
const read = (name: string) => readFileSync(fileURLToPath(new URL(name, DATA)), "utf8");

/** The same four texts app/src/bank-files.ts bundles with `?raw`. */
export function bankFiles(): BankFiles {
  return {
    n5: read("n5.csv"),
    n4: read("n4.csv"),
    glossCorrections: read("gloss-corrections.csv"),
    falseFriends: read("false-friends.txt"),
  };
}

/** Deterministic PRNG (mulberry32): both engines must see the same choices. */
export function rngFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fixed local-noon start, so newIntroducedToday's day boundary is not crossed by accident. */
export const T0 = new Date(2026, 0, 15, 12, 0, 0).getTime();

export interface Step {
  t: number;
  kind: "teach" | "answer" | "idle";
  itemId?: number;
  mode?: string;
  prompt?: string;
  choices?: string[];
  answerIndex?: number;
  response?: string | number;
  correct?: boolean;
  rating?: number;
  nextDue?: number;
}

export interface Session { steps: Step[]; now: number }

/**
 * Drive `answers` graded answers. Teach-first cards are introduced (not
 * graded), as the UI does. Answers are right ~70% of the time, otherwise a
 * wrong choice or "?" -- so Again/Hard/Good all occur and lapses happen.
 */
export function drive(db: Db, answers: number, seed: number, start = T0): Session {
  const rng = rngFrom(seed);
  const steps: Step[] = [];
  let now = start;
  let graded = 0;
  let guard = 0;
  while (graded < answers && guard++ < answers * 20) {
    const q: Question | null = nextQuestion(db, { now, rng, newLimit: 40 });
    if (!q) {
      // Jump to the next due card, like a learner coming back later.
      const next = db.query<{ due: number | null }, []>(
        "SELECT MIN(due) AS due FROM cards WHERE introduced = 1").get()?.due;
      now = Math.max(now + 60_000, next ?? now + 3_600_000);
      steps.push({ t: now, kind: "idle" });
      continue;
    }
    if (q.teachFirst) {
      introduceCard(db, q.itemId, q.mode, now);
      steps.push({ t: now, kind: "teach", itemId: q.itemId, mode: q.mode, prompt: q.prompt });
      now += 5_000;
      continue;
    }
    const r = rng();
    let response: string | number;
    if (q.choices.length > 0) {
      response = r < 0.7 ? q.answerIndex : r < 0.9 ? (q.answerIndex + 1) % q.choices.length : DONT_KNOW;
    } else {
      response = r < 0.7 ? q.answer : r < 0.85 ? "zzz" : DONT_KNOW;
    }
    // Over 12 s now and then, so Hard is exercised too.
    const elapsed = Math.floor(rng() * 16_000);
    const g = grade(db, q, response, elapsed, { now, rng });
    steps.push({
      t: now, kind: "answer", itemId: q.itemId, mode: q.mode, prompt: q.prompt,
      choices: q.choices, answerIndex: q.answerIndex, response,
      correct: g.correct, rating: g.rating, nextDue: g.nextDue,
    });
    graded++;
    now += 8_000 + elapsed;
  }
  return { steps, now };
}

/** Everything about the deck a backup or an engine swap must preserve. */
export function snapshot(db: Db, now: number) {
  return {
    items: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM items").get()!.n,
    cards: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM cards").get()!.n,
    fingerprint: bankFingerprint(db),
    due: dueCount(db, now),
    introduced: db.query<Record<string, unknown>, []>(
      `SELECT item_id, mode, stability, difficulty, state, step, due, last_review, introduced, introduced_at
         FROM cards WHERE introduced = 1 ORDER BY item_id, mode`).all(),
    reviews: db.query<Record<string, unknown>, []>(
      "SELECT item_id, mode, rating, correct, ts, elapsed_ms, sentence_id FROM reviews ORDER BY id").all(),
    settings: db.query<Record<string, unknown>, []>("SELECT k, v FROM settings ORDER BY k").all(),
  };
}

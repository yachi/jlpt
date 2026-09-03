/**
 * Three defects found by playing the app, 2026-09-03.
 *
 * All three share the shape that has now bitten four times in this repo: every
 * function returned successfully while the question put to the learner was
 * unanswerable, or the answer it taught was wrong.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb } from "./db";
import { distractors, homophoneGlosses, applyGlossCorrections, shortMeaning, type Item } from "./bank";
import { buildQuestion, checkAnswer, DONT_KNOW } from "./quiz";

function bank(): Database {
  const db = openDb(":memory:");
  const ins = db.query(
    "INSERT INTO items (level, expression, reading, meaning, has_kanji) VALUES (?,?,?,?,?)");
  // Three homophones, plus filler so distractors() has a pool to draw from.
  ins.run("N5", "暑い", "あつい", "hot (in reference to weather), warm", 1);
  ins.run("N5", "熱い", "あつい", "hot (objects)", 1);
  ins.run("N5", "厚い", "あつい", "kind, warm(hearted), thick, deep", 1);
  for (let i = 0; i < 30; i++) ins.run("N5", `語${i}`, `ご${i}`, `filler ${i}`, 1);
  return db;
}
const item = (db: Database, expr: string) =>
  db.query<Item, [string]>("SELECT * FROM items WHERE expression = ?").get(expr)!;

// ---------------------------------------------------------------- homophones

test("homophoneGlosses returns the rivals' glosses, not the item's own", () => {
  const db = bank();
  expect(homophoneGlosses(db, item(db, "暑い")).sort())
    .toEqual(["hot (objects)", "kind"]);
  db.close();
});

test("a word with a unique reading has no homophone rivals", () => {
  const db = bank();
  expect(homophoneGlosses(db, item(db, "語7"))).toEqual([]);
  db.close();
});

test("a listening card never offers a homophone's gloss as a distractor", () => {
  const db = bank();
  for (const expr of ["暑い", "熱い", "厚い"]) {
    const it = item(db, expr);
    const rivals = new Set(homophoneGlosses(db, it).map((g) => g.toLowerCase()));
    for (let seed = 0; seed < 400; seed++) {
      let s = seed * 2654435761 + 1;
      const rng = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
      const q = buildQuestion(db, it, "listening", false, rng);
      const also = q.choices.filter((c, i) => i !== q.answerIndex && rivals.has(c.toLowerCase()));
      expect(also).toEqual([]);
    }
  }
  db.close();
});

test("MUTATION: without the exclusion the ambiguous card does appear", () => {
  // Proves the guard above is load-bearing rather than decorative: the same
  // search WITHOUT passing homophoneGlosses finds real collisions.
  const db = bank();
  const it = item(db, "暑い");
  const rivals = new Set(homophoneGlosses(db, it).map((g) => g.toLowerCase()));
  let collisions = 0;
  for (let seed = 0; seed < 400; seed++) {
    let s = seed * 2654435761 + 1;
    const rng = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    const ds = distractors(db, it, "meaning", 3, rng);          // <- guard removed
    collisions += ds.filter((d) => rivals.has(d.toLowerCase())).length;
  }
  expect(collisions).toBeGreaterThan(0);
  db.close();
});

test("meaning cards KEEP homophone glosses — the kanji is on screen", () => {
  // 熱い as a distractor for 暑い is the most instructive option in the bank.
  const db = bank();
  const it = item(db, "暑い");
  const rivals = new Set(homophoneGlosses(db, it).map((g) => g.toLowerCase()));
  let seen = 0;
  for (let seed = 0; seed < 400; seed++) {
    let s = seed * 2654435761 + 1;
    const rng = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    seen += buildQuestion(db, it, "meaning", false, rng)
      .choices.filter((c) => rivals.has(c.toLowerCase())).length;
  }
  expect(seen).toBeGreaterThan(0);
  db.close();
});

// ---------------------------------------------------------------- don't know

test("DONT_KNOW grades wrong for every mode", () => {
  const db = bank();
  for (const mode of ["meaning", "reading", "listening", "production"] as const) {
    const q = buildQuestion(db, item(db, "暑い"), mode, false);
    expect(checkAnswer(q, DONT_KNOW)).toBe(false);
  }
  db.close();
});

test("DONT_KNOW is rejected even when it is the literal answer index", () => {
  // The sentinel must not depend on Number("?") being NaN.
  const db = bank();
  const q = buildQuestion(db, item(db, "暑い"), "listening", false);
  const asIndex = { ...q, answerIndex: Number.NaN };
  expect(checkAnswer(asIndex, DONT_KNOW)).toBe(false);
  db.close();
});

test("a correct answer still grades correct", () => {
  const db = bank();
  const q = buildQuestion(db, item(db, "暑い"), "listening", false);
  expect(checkAnswer(q, q.answerIndex)).toBe(true);
  db.close();
});

// ---------------------------------------------------------- gloss correction

test("applyGlossCorrections replaces the gloss it asserts, and is idempotent", async () => {
  const db = openDb(":memory:");
  db.query("INSERT INTO items (level, expression, reading, meaning, has_kanji) VALUES (?,?,?,?,?)")
    .run("N5", "あちら", "あちら", "this way (polite)", 0);

  const first = await applyGlossCorrections(db);
  expect(first.applied).toBe(1);
  expect(first.stale).toEqual([]);
  expect(db.query<{ meaning: string }, []>("SELECT meaning FROM items").get()!.meaning)
    .toBe("that way, over there (polite)");

  const second = await applyGlossCorrections(db);
  expect(second.applied).toBe(0);
  expect(second.stale).toEqual([]);
  db.close();
});

test("a correction whose `was` no longer matches is reported stale, not applied", async () => {
  const db = openDb(":memory:");
  db.query("INSERT INTO items (level, expression, reading, meaning, has_kanji) VALUES (?,?,?,?,?)")
    .run("N5", "あちら", "あちら", "upstream fixed this to something else", 0);
  const r = await applyGlossCorrections(db);
  expect(r.applied).toBe(0);
  expect(r.stale.length).toBe(1);
  expect(db.query<{ meaning: string }, []>("SELECT meaning FROM items").get()!.meaning)
    .toBe("upstream fixed this to something else");
  db.close();
});

test("a correction naming a word outside the bank is reported, not silent", async () => {
  const db = openDb(":memory:");
  const r = await applyGlossCorrections(db);
  expect(r.applied).toBe(0);
  expect(r.missing.length).toBe(1);
  db.close();
});

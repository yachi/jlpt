/**
 * A word that has never been shown must be TAUGHT, not asked.
 *
 * Found by playing the app, 2026-09-03: a brand-new card was served as a blind
 * four-choice quiz. "I don't know" was the only honest answer to a word the
 * learner had never seen, and it was recorded as a lapse.
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, setSetting, MODES } from "./db";
import { nextQuestion, introduceCard, grade, INTRODUCE_DELAY_MS } from "./quiz";

function deck(): Database {
  const db = openDb(":memory:");
  const ins = db.query(
    "INSERT INTO items (level, expression, reading, meaning, has_kanji) VALUES (?,?,?,?,?)");
  const card = db.query("INSERT INTO cards (item_id, mode, due, introduced) VALUES (?,?,0,0)");
  for (let i = 1; i <= 40; i++) {
    ins.run("N5", `語${i}`, `ご${i}`, `word ${i}`, 1);
    for (const m of MODES) card.run(i, m);
  }
  return db;
}
const cardRow = (db: Database, id: number, mode: string) =>
  db.query<any, [number, string]>("SELECT * FROM cards WHERE item_id=? AND mode=?").get(id, mode)!;

test("a never-seen card is flagged to teach, not to ask", () => {
  const db = deck();
  const q = nextQuestion(db)!;
  expect(q.isNew).toBe(true);
  expect(q.teachFirst).toBe(true);
  db.close();
});

test("teach_new_first=0 restores the old blind-quiz behaviour", () => {
  const db = deck();
  setSetting(db, "teach_new_first", "0");
  expect(nextQuestion(db)!.teachFirst).toBeUndefined();
  db.close();
});

test("the exam never teaches — it measures", () => {
  const db = deck();
  expect(nextQuestion(db, { teachNew: false })!.teachFirst).toBeUndefined();
  db.close();
});

test("introduceCard writes NO review row — nothing was asked", () => {
  const db = deck();
  const q = nextQuestion(db)!;
  introduceCard(db, q.itemId, q.mode, 1000);
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM reviews").get()!.n).toBe(0);
  db.close();
});

test("an introduced card is scheduled for a LATER first test, not an instant one", () => {
  const db = deck();
  // A realistic clock: the sibling cutoff is `now - 20h`, so an epoch-zero
  // timestamp makes it negative and every card compares "recently seen".
  const T = 1_788_000_000_000;
  const q = nextQuestion(db, { now: T })!;
  const { due } = introduceCard(db, q.itemId, q.mode, T);
  expect(due).toBe(T + INTRODUCE_DELAY_MS);
  expect(cardRow(db, q.itemId, q.mode).due).toBe(T + INTRODUCE_DELAY_MS);
  // Quizzing it immediately would measure short-term memory, not the word --
  // and neither may a SIBLING mode of the same word, which is the same defect
  // wearing a different mode. An introduction writes no review row, so the
  // cooldown has to read introduced_at as well as the review log.
  const next = nextQuestion(db, { now: T })!;
  expect(`${next.itemId}:${next.mode}`).not.toBe(`${q.itemId}:${q.mode}`);
  expect(next.itemId).not.toBe(q.itemId);
  db.close();
});

test("the stored state is a virgin card, so the first real review is a first review", () => {
  const db = deck();
  const q = nextQuestion(db)!;
  introduceCard(db, q.itemId, q.mode, 1000);
  const row = cardRow(db, q.itemId, q.mode);
  expect(row.introduced).toBe(1);
  expect(row.introduced_at).toBe(1000);
  expect(row.stability).toBeNull();
  expect(row.difficulty).toBeNull();
  expect(row.state).toBe("learning");
  expect(row.step).toBe(0);
  expect(row.last_review).toBeNull();
  db.close();
});

test("grading a taught card behaves exactly like grading an untaught one", () => {
  // Two identical decks; one card is taught first, the other is not. Same
  // answer, same clock -> the scheduler must land in the same place.
  const a = deck(), b = deck();
  const qa = nextQuestion(a, { now: 1000 })!;
  introduceCard(a, qa.itemId, qa.mode, 1000);
  const ga = grade(a, qa, qa.answerIndex, 0, { now: 1000 + INTRODUCE_DELAY_MS });

  const qb = nextQuestion(b, { now: 1000 })!;
  const gb = grade(b, qb, qb.answerIndex, 0, { now: 1000 + INTRODUCE_DELAY_MS });

  expect(ga.stability).toBe(gb.stability);
  expect(ga.nextDue).toBe(gb.nextDue);
  a.close(); b.close();
});

test("the daily budget is spent by TEACHING, not by being tested", () => {
  // The old counter read the review log. A learner who is taught 5 words and
  // stops before the follow-up test would have been handed 5 more.
  const db = deck();
  setSetting(db, "new_per_day", "3");
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    const q = nextQuestion(db, { now })!;
    expect(q.teachFirst).toBe(true);
    introduceCard(db, q.itemId, q.mode, now);
  }
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM reviews").get()!.n).toBe(0);
  expect(nextQuestion(db, { now })).toBeNull();   // budget spent, nothing due yet
  db.close();
});

test("MUTATION: counting first reviews instead would blow the budget", () => {
  const db = deck();
  const now = Date.now();
  const startOfDay = new Date(now).setHours(0, 0, 0, 0);
  for (let i = 0; i < 3; i++) {
    const q = nextQuestion(db, { now })!;
    introduceCard(db, q.itemId, q.mode, now);
  }
  const byIntroduction = db.query<{ n: number }, [number]>(
    "SELECT COUNT(*) AS n FROM cards WHERE introduced_at >= ?").get(startOfDay)!.n;
  const byFirstReview = db.query<{ n: number }, [number]>(
    `SELECT COUNT(DISTINCT item_id || ':' || mode) AS n FROM reviews
      WHERE ts >= ? AND id IN (SELECT MIN(id) FROM reviews GROUP BY item_id, mode)`).get(startOfDay)!.n;
  expect(byIntroduction).toBe(3);
  expect(byFirstReview).toBe(0);       // the old query sees nothing
  db.close();
});

test("introduceCard cannot resurrect a card that is already in the deck", () => {
  const db = deck();
  const q = nextQuestion(db)!;
  introduceCard(db, q.itemId, q.mode, 1000);
  grade(db, q, q.answerIndex, 0, { now: 1000 + INTRODUCE_DELAY_MS });
  const after = cardRow(db, q.itemId, q.mode);
  introduceCard(db, q.itemId, q.mode, 9_999_999);   // guarded by introduced = 0
  expect(cardRow(db, q.itemId, q.mode).due).toBe(after.due);
  expect(cardRow(db, q.itemId, q.mode).stability).toBe(after.stability);
  db.close();
});

test("the migration backfills introduced_at from the review log", () => {
  // Simulate a pre-migration deck: cards introduced by their first review, with
  // no introduced_at. The column must be filled from that review's timestamp,
  // or every historical card counts as introduced today.
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE cards (item_id INTEGER NOT NULL, mode TEXT NOT NULL, stability REAL,
      difficulty REAL, state TEXT NOT NULL DEFAULT 'learning', step INTEGER,
      due INTEGER NOT NULL, last_review INTEGER, introduced INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (item_id, mode));
    CREATE TABLE reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
      mode TEXT NOT NULL, rating INTEGER NOT NULL, correct INTEGER NOT NULL, ts INTEGER NOT NULL,
      elapsed_ms INTEGER);
    INSERT INTO cards (item_id, mode, due, introduced) VALUES (1,'meaning',0,1),(2,'meaning',0,0);
    INSERT INTO reviews (item_id, mode, rating, correct, ts) VALUES (1,'meaning',3,1,555),(1,'meaning',3,1,999);
  `);
  // openDb() runs migrate() against whatever it finds.
  const cols = () => db.query<{ name: string }, []>("PRAGMA table_info(cards)").all().map((c) => c.name);
  expect(cols()).not.toContain("introduced_at");
  db.exec("ALTER TABLE cards ADD COLUMN introduced_at INTEGER");
  db.exec(`UPDATE cards SET introduced_at = (
             SELECT MIN(r.ts) FROM reviews r WHERE r.item_id = cards.item_id AND r.mode = cards.mode)
           WHERE introduced = 1 AND introduced_at IS NULL`);
  expect(db.query<any, []>("SELECT introduced_at FROM cards WHERE item_id=1").get()!.introduced_at).toBe(555);
  expect(db.query<any, []>("SELECT introduced_at FROM cards WHERE item_id=2").get()!.introduced_at).toBeNull();
  db.close();
});

test("MUTATION: without introduced_at in the cooldown, a sibling mode comes straight back", () => {
  // Proves the cooldown change is load-bearing. Ranks the same candidate pool
  // by the OLD expression (review log only) and shows the just-taught word's
  // sibling sorts to the front, which is exactly what the cooldown forbids.
  const db = deck();
  const T = 1_788_000_000_000;
  const q = nextQuestion(db, { now: T })!;
  introduceCard(db, q.itemId, q.mode, T);
  const cutoff = T - 20 * 3_600_000;

  const oldRank = db.query<{ item_id: number }, [number]>(
    `SELECT c.item_id FROM cards c WHERE c.introduced = 0 AND c.mode = 'listening'
      ORDER BY COALESCE((SELECT MAX(r.ts) FROM reviews r WHERE r.item_id = c.item_id), 0) > ? ASC,
               c.item_id ASC LIMIT 1`).get(cutoff)!;
  const newRank = db.query<{ item_id: number }, [number]>(
    `SELECT c.item_id FROM cards c WHERE c.introduced = 0 AND c.mode = 'listening'
      ORDER BY MAX(COALESCE((SELECT MAX(r.ts) FROM reviews r WHERE r.item_id = c.item_id), 0),
                   COALESCE((SELECT MAX(s.introduced_at) FROM cards s WHERE s.item_id = c.item_id), 0)
               ) > ? ASC,
               c.item_id ASC LIMIT 1`).get(cutoff)!;

  expect(oldRank.item_id).toBe(q.itemId);        // old: serves the sibling
  expect(newRank.item_id).not.toBe(q.itemId);    // new: defers it
  db.close();
});

test("grading a card that was never taught still stamps introduced_at", () => {
  // The budget must hold on every path out of the new queue, not just the
  // teach-first one: with teach_new_first off, or inside the exam, grade() is
  // what introduces the card. Without this the daily limit stops existing.
  const db = deck();
  setSetting(db, "teach_new_first", "0");
  const T = 1_788_000_000_000;
  const q = nextQuestion(db, { now: T })!;
  expect(q.teachFirst).toBeUndefined();
  grade(db, q, q.answerIndex, 0, { now: T });
  expect(cardRow(db, q.itemId, q.mode).introduced_at).toBe(T);
  db.close();
});

test("introduced_at records the FIRST exit from the new queue, not the last review", () => {
  const db = deck();
  setSetting(db, "teach_new_first", "0");
  const T = 1_788_000_000_000;
  const q = nextQuestion(db, { now: T })!;
  grade(db, q, q.answerIndex, 0, { now: T });
  grade(db, q, q.answerIndex, 0, { now: T + 86_400_000 });
  // Overwriting here would make every review look like a new introduction, and
  // the daily counter would read the whole deck as introduced today.
  expect(cardRow(db, q.itemId, q.mode).introduced_at).toBe(T);
  db.close();
});

test("a taught card always speaks the reading, whatever the mode would play", () => {
  // reading/production cards carry no audio, and meaning plays the expression —
  // the kanji the TTS mispronounces. Meeting a word for the first time without
  // hearing it defeats the point of teaching it.
  const db = deck();
  const T = 1_788_000_000_000;
  for (const mode of MODES) {
    const q = nextQuestion(db, { now: T, mode })!;
    expect(q.teachFirst).toBe(true);
    expect(q.audioText).toBe(`ご${q.itemId}`);      // the reading, not the kanji
    expect(q.audioIsStimulus).toBe(false);          // it is a reveal, not a question
    introduceCard(db, q.itemId, q.mode, T);
  }
  db.close();
});

test("the nothing-due message names when the next card lands, not 'tomorrow'", () => {
  // Teach-first made this the common case: spending the daily budget leaves a
  // pile of taught-but-untested cards due in ten minutes, and telling the
  // learner to come back tomorrow sends them away from work that is waiting.
  const db = deck();
  const T = 1_788_000_000_000;
  for (let i = 0; i < 3; i++) {
    const q = nextQuestion(db, { now: T, newLimit: 3 })!;
    introduceCard(db, q.itemId, q.mode, T);
  }
  expect(nextQuestion(db, { now: T, newLimit: 3 })).toBeNull();
  const soonest = db.query<{ due: number }, [number]>(
    "SELECT MIN(due) AS due FROM cards WHERE introduced = 1 AND due > ?").get(T)!.due;
  expect(soonest).toBe(T + INTRODUCE_DELAY_MS);
  // ...and those cards really do become available once that delay passes.
  expect(nextQuestion(db, { now: T + INTRODUCE_DELAY_MS, newLimit: 3 })).not.toBeNull();
  db.close();
});

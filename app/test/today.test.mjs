// The day-goal and streak logic (src/ui/today.ts), on the real schema and word
// lists through the sql.js adapter. Everything it reports is derived from the
// review log and cards.introduced_at, so the tests write those rows directly.
import { register } from "tsx/esm/api";
import { test } from "node:test";
import assert from "node:assert/strict";
import initSqlJs from "sql.js";

register();
const { SqlJsDb } = await import("../src/platform/sqljs-db.ts");
const { bankFiles } = await import("./drive.ts");
const { seedFrom } = await import("../../src/bank.ts");
const { initSchema, setSetting } = await import("../../src/schema.ts");
const { introduceCard } = await import("../../src/quiz.ts");
const { todayPlan, streak, startOfDay } = await import("../src/ui/today.ts");

const SQL = await initSqlJs();
const FILES = bankFiles();
// Noon local time, so "a day earlier" never crosses midnight by accident.
const NOW = new Date(2026, 10, 15, 12, 0, 0).getTime();
const day = (n) => { const d = new Date(NOW); d.setDate(d.getDate() + n); return d.getTime(); };

function fresh() {
  const db = SqlJsDb.open(SQL);
  initSchema(db);
  seedFrom(db, FILES, day(-60));
  return db;
}
function studied(db, t, correct = 1) {
  db.query("INSERT INTO reviews (item_id, mode, rating, correct, ts, elapsed_ms) VALUES (1, 'meaning', 3, ?, ?, 5000)")
    .run(correct, t);
}
const studyDays = (db, ...offsets) => offsets.forEach((o) => studied(db, day(o)));

test("a fresh day: the goal is today's new words, two steps each with teach-first", () => {
  const db = fresh();
  const p = todayPlan(db, NOW);
  assert.equal(p.done, 0);
  assert.equal(p.remaining, 10);
  assert.ok(p.minutesLeft >= 1);
  setSetting(db, "teach_new_first", "0");
  assert.equal(todayPlan(db, NOW).remaining, 5);
});

test("teaching a word moves one step to done and keeps its test in today's goal", () => {
  const db = fresh();
  const before = todayPlan(db, NOW);
  const id = db.query("SELECT item_id AS id FROM cards WHERE mode = 'meaning' LIMIT 1").get().id;
  introduceCard(db, id, "meaning", NOW);
  const after = todayPlan(db, NOW);
  assert.equal(after.done, 1);
  // The goal does not move: the test ten minutes out was already counted.
  assert.equal(after.goal, before.goal);
});

test("answers today count, yesterday's do not", () => {
  const db = fresh();
  studied(db, day(-1));
  studied(db, startOfDay(NOW) + 1000, 1);
  studied(db, NOW - 1000, 0);
  const p = todayPlan(db, NOW);
  assert.equal(p.answered, 2);
  assert.equal(p.correct, 1);
});

test("streak: none before any study, and today counts once studied", () => {
  const db = fresh();
  assert.deepEqual(streak(db, NOW), { days: 0, freezes: 0, today: false });
  studied(db, NOW);
  assert.deepEqual(streak(db, NOW), { days: 1, freezes: 1, today: true });
});

test("streak: today not yet studied does not break the run", () => {
  const db = fresh();
  studyDays(db, -3, -2, -1);
  assert.deepEqual(streak(db, NOW), { days: 3, freezes: 1, today: false });
});

test("streak: one missed day spends the freeze and the run goes on", () => {
  const db = fresh();
  studyDays(db, -3, -2, 0);
  assert.deepEqual(streak(db, NOW), { days: 3, freezes: 0, today: true });
});

test("streak: a second miss with no freeze left starts over", () => {
  const db = fresh();
  studyDays(db, -6, -5, -3, -2);   // the miss at -4 spends the freeze
  assert.equal(streak(db, day(-1)).days, 4);
  // -1 and today missed: -1 has no freeze to spend, so the run ends.
  assert.deepEqual(streak(db, day(1)), { days: 0, freezes: 0, today: false });
});

test("streak: every 7 days studied earns a freeze, holding at most 2", () => {
  const db = fresh();
  studyDays(db, ...Array.from({ length: 21 }, (_, i) => i - 21));
  // Start 1, +1 at day 7, +1 at day 14 capped at 2, day 21 still 2.
  assert.deepEqual(streak(db, NOW), { days: 21, freezes: 2, today: false });
  // Two missed days are both covered.
  assert.equal(streak(db, day(2)).days, 21);
});

test("streak: words taught count as study, not only answers", () => {
  const db = fresh();
  const id = db.query("SELECT item_id AS id FROM cards WHERE mode = 'meaning' LIMIT 1").get().id;
  introduceCard(db, id, "meaning", NOW);
  assert.equal(streak(db, NOW).today, true);
});

test("the plan leaves out cards the study screen will not serve", () => {
  const db = fresh();
  setSetting(db, "new_per_day", "0");
  const ids = db.query("SELECT item_id AS id FROM cards WHERE mode = 'listening' LIMIT 3").all().map((r) => r.id);
  for (const id of ids) introduceCard(db, id, "listening", day(-1));
  assert.equal(todayPlan(db, NOW).remaining, 3);
  // No Japanese voice: listening cards are skipped, so they are not today's work.
  assert.equal(todayPlan(db, NOW, { canHear: false }).remaining, 0);
  // A mode filter on another mode leaves them out too.
  assert.equal(todayPlan(db, NOW, { mode: "reading" }).remaining, 0);
});

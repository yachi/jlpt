/**
 * Phase 0 gate: is there enough corpus UNDER THE REAL SCHEDULE?
 *
 * Static coverage answers "for a learner who already knows all 1,384 words".
 * The binding question is coverage conditional on the known set at day N, so
 * this drives the ACTUAL engine -- seed(), nextQuestion(), grade() -- against a
 * simulated clock rather than reimplementing the scheduling policy, which would
 * drift from quiz.ts the moment either changed.
 *
 * Usage: bun tools/simulate_gate.ts <sentences.json> [days]
 */
import { openDb, setSetting, type Mode } from "../src/db";
import { seed } from "../src/bank";
import { nextQuestion, grade } from "../src/quiz";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Sentence { id: number; items: number[]; ambiguous: number[] }

const DAY = 86_400_000;
const [, , corpusPath, daysArg] = Bun.argv;
if (!corpusPath) {
  console.error("usage: bun tools/simulate_gate.ts <sentences.json> [days] [minItems]");
  process.exit(1);
}
const DAYS = Number(daysArg ?? "120");
const corpus: Sentence[] = await Bun.file(corpusPath).json();

/**
 * Minimum content words for a sentence to be worth serving.
 *
 * "Aki desu ne." is a one-word sentence: it carries no context, so it teaches
 * nothing the word stimulus did not. Ordering by shortest-eligible actively
 * SELECTS those degenerate cases, so the floor is what makes the feature mean
 * anything. Measured at 1 (no floor), 2, and 3.
 */
const MIN_ITEMS = Number(Bun.argv[4] ?? "1");

// item -> sentences that can TARGET it (certain occurrence, not homophone-only)
const byTarget = new Map<number, Sentence[]>();
for (const s of corpus) {
  if (s.items.length + s.ambiguous.length < MIN_ITEMS) continue;
  for (const i of s.items) {
    let a = byTarget.get(i);
    if (!a) byTarget.set(i, (a = []));
    a.push(s);
  }
}

/** Deterministic PRNG so a run is reproducible. */
function mulberry(seedN: number) {
  return () => {
    seedN |= 0; seedN = (seedN + 0x6d2b79f5) | 0;
    let t = Math.imul(seedN ^ (seedN >>> 15), 1 | seedN);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function run(accuracy: number, label: string, checkpoints: number[]) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "jlpt-sim-")), "sim.db"));
  await seed(db);
  // The user's real configuration.
  setSetting(db, "new_per_day", "12");
  setSetting(db, "mode_weights", "listening:45,reading:30,production:15,meaning:10");
  setSetting(db, "skip_meaning_for_kanji", "1");

  const rng = mulberry(20260823);
  const rows: string[] = [];

  for (let day = 1; day <= DAYS; day++) {
    const t0 = day * DAY + 9 * 3600_000;
    // Answer everything the scheduler offers today, capped to keep the sim
    // bounded; the cap is far above any realistic day's queue.
    for (let k = 0; k < 400; k++) {
      const q = nextQuestion(db, { now: t0, rng });
      if (!q) break;
      const correct = rng() < accuracy;
      // Production cards are typed, not multiple choice: answerIndex is -1, so
      // grading them by index would score every one of them wrong.
      const response = q.mode === "production"
        ? (correct ? q.answer : "ぜったいちがう")
        : String(correct ? q.answerIndex : (q.answerIndex + 1) % 4);
      grade(db, q, response, 3000, { now: t0 + k * 1000, rng });
    }

    if (!checkpoints.includes(day)) continue;

    // Known BY EAR: the listening card has graduated initial learning.
    const heard = new Set(db.query<{ item_id: number }, []>(
      `SELECT item_id FROM cards
        WHERE mode='listening' AND introduced=1 AND state<>'learning'`).all()
      .map((r) => r.item_id));

    const introducedListening = db.query<{ item_id: number }, []>(
      "SELECT item_id FROM cards WHERE mode='listening' AND introduced=1").all()
      .map((r) => r.item_id);

    // A sentence is eligible for target X when every OTHER of its words is
    // known by ear. Ambiguous (homophone) words count as known if any of their
    // candidates is.
    const eligibleFor = (target: number) => {
      for (const s of byTarget.get(target) ?? []) {
        let ok = true;
        for (const i of s.items) if (i !== target && !heard.has(i)) { ok = false; break; }
        if (ok) for (const i of s.ambiguous) if (i !== target && !heard.has(i)) { ok = false; break; }
        if (ok) return s;
      }
      return null;
    };

    const withSentence = introducedListening.filter((i) => eligibleFor(i) !== null);
    const distinct = new Set<number>();
    for (const i of introducedListening) { const s = eligibleFor(i); if (s) distinct.add(s.id); }

    rows.push(
      `${String(day).padStart(4)} ${String(heard.size).padStart(7)} ` +
      `${String(introducedListening.length).padStart(9)} ` +
      `${String(withSentence.length).padStart(9)} ` +
      `${(introducedListening.length ? withSentence.length / introducedListening.length : 0)
        .toLocaleString("en", { style: "percent", minimumFractionDigits: 1 }).padStart(7)} ` +
      `${String(distinct.size).padStart(9)}`);
  }

  db.close();
  console.log(`\n=== ${label} (min ${MIN_ITEMS} content words) ===`);
  console.log(" day  known    listen  w/ sent       %  distinct");
  console.log(rows.join("\n"));
}

const CHECKPOINTS = [15, 30, 60, 90, 120].filter((d) => d <= DAYS);
// 50% is not a plausible learner. It is a sensitivity control: if the gate
// number does not move when half the answers are wrong, the simulation is not
// actually exercising the scheduler and the result means nothing.
await run(0.9, "90% accuracy", CHECKPOINTS);

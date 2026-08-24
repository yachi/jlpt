import { describe, expect, test, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, setSetting, ROOT, type Mode } from "./db";
import { seed, shortMeaning, distractors, parseCsv, type Item } from "./bank";
import { buildQuestion, grade, nextQuestion, slowThresholdFor, ratingFor, SLOW_MS } from "./quiz";
import {
  importSentences, pickSentence, recomputeUnheard, unheardDrift, sentenceCoverage,
  decrementUnheardFor, SENTENCE_SETTING,
} from "./sentences";

function mulberry(seedN: number) {
  return () => {
    seedN |= 0; seedN = (seedN + 0x6d2b79f5) | 0;
    let t = Math.imul(seedN ^ (seedN >>> 15), 1 | seedN);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tmp = () => join(mkdtempSync(join(tmpdir(), "jlpt-sent-")), "t.json");

/** Mark a listening card as known by ear without going through the scheduler. */
function markHeard(db: Database, itemId: number) {
  db.query("UPDATE cards SET introduced=1, state='review' WHERE item_id=? AND mode='listening'")
    .run(itemId);
}

describe("reviews.sentence_id migration", () => {
  test("openDb adds the column to a database that predates it", () => {
    const path = join(mkdtempSync(join(tmpdir(), "jlpt-mig-")), "old.db");
    const old = new Database(path, { create: true });
    // The exact pre-migration shape, so this test fails if the guard is dropped.
    old.exec(`CREATE TABLE reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, mode TEXT NOT NULL,
      rating INTEGER NOT NULL, correct INTEGER NOT NULL, ts INTEGER NOT NULL, elapsed_ms INTEGER)`);
    old.query("INSERT INTO reviews (item_id,mode,rating,correct,ts) VALUES (1,'meaning',3,1,99)").run();
    old.close();

    const db = openDb(path);
    const cols = db.query<{ name: string }, []>("PRAGMA table_info(reviews)").all().map((c) => c.name);
    expect(cols).toContain("sentence_id");
    // CREATE TABLE IF NOT EXISTS would have silently done nothing; the existing
    // row must survive the ALTER with a NULL stimulus.
    expect(db.query<{ n: number; s: number | null }, []>(
      "SELECT COUNT(*) AS n, sentence_id AS s FROM reviews").get())
      .toEqual({ n: 1, s: null });

    // Running it twice must be harmless — there is no version number to consult.
    db.close();
    const again = openDb(path);
    expect(again.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM reviews").get()!.n).toBe(1);
    again.close();
  });
});

describe("the bank identity guard", () => {
  const KANJI_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

  /** seed()'s exact item insert, so id assignment is faithful. */
  function insertItems(db: Database, rows: { level: string; cells: string[] }[]) {
    const ins = db.query(
      `INSERT INTO items (level, expression, reading, meaning, has_kanji) VALUES (?,?,?,?,?)
       ON CONFLICT(level, expression, reading) DO NOTHING`);
    db.transaction(() => {
      for (const { level, cells } of rows) {
        ins.run(level, cells[0]!, cells[1]!, cells[2]!, KANJI_RE.test(cells[0]!) ? 1 : 0);
      }
    })();
  }

  test("a bank whose ids shifted is refused, even though every id exists", async () => {
    // The scenario: seeded once when n5.csv was one row shorter, then re-seeded
    // after the row came back. ON CONFLICT DO NOTHING gives the late arrival an
    // id at the END, so every word after it keeps an id that now names its
    // neighbour. Measured on the real CSVs: 1184 of 1384 ids move.
    const all: { level: string; cells: string[] }[] = [];
    for (const level of ["N5", "N4"] as const) {
      const rows = parseCsv(await Bun.file(join(ROOT, "data", `${level.toLowerCase()}.csv`)).text());
      for (const cells of rows.slice(1)) {
        if (cells.length >= 3 && cells[0] && cells[1] && cells[2]) all.push({ level, cells });
      }
    }
    const skewed = openDb(":memory:");
    insertItems(skewed, all.filter((_, i) => i !== 200));  // the old CSV
    insertItems(skewed, all);                              // the upgrade

    const fresh = openDb(":memory:");
    await seed(fresh);
    // Precondition: the ids all still EXIST, which is why existence is not a guard.
    const freshIds = fresh.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM items").get()!.n;
    expect(skewed.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM items").get()!.n).toBe(freshIds);
    const label = (db: Database) => new Map(db.query<
      { id: number; expression: string }, []>("SELECT id, expression FROM items").all()
      .map((i) => [i.id, i.expression]));
    const a = label(fresh), b = label(skewed);
    const moved = [...a].filter(([id, e]) => b.get(id) !== e).length;
    expect(moved).toBeGreaterThan(1000);

    await expect(importSentences(skewed)).rejects.toThrow(/not the one data\/sentences\.json was built against/);
    expect(skewed.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sentences").get()!.n).toBe(0);
  }, 60_000);

  test("re-seeding into a changed bank drops the links instead of serving them", async () => {
    const db = openDb(":memory:");
    await seed(db);
    await importSentences(db);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sentences").get()!.n).toBeGreaterThan(0);

    // Same ids, different word behind one of them.
    db.query("UPDATE items SET expression = ?, reading = ? WHERE id = 1").run("ZZZ", "ずずず");
    const again = await seed(db);
    expect(again.droppedSentences).toBeGreaterThan(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sentences").get()!.n).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sentence_items").get()!.n).toBe(0);
  }, 60_000);

  test("an unchanged bank keeps its links across a re-seed", async () => {
    // The guard must not fire on the ordinary case, or every seed wipes the corpus.
    const db = openDb(":memory:");
    await seed(db);
    await importSentences(db);
    const before = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sentences").get()!.n;
    const again = await seed(db);
    expect(again.droppedSentences).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sentences").get()!.n).toBe(before);
  }, 60_000);
});

describe("sentence stimulus", () => {
  let db: Database;
  let items: Item[];
  /** target, plus two context words */
  let target: Item, ctxA: Item, ctxB: Item, outsider: Item;
  let corpusPath: string;

  beforeAll(async () => {
    db = openDb(":memory:");
    await seed(db);
    items = db.query<Item, []>("SELECT * FROM items ORDER BY id").all();
    [target, ctxA, ctxB, outsider] = [items[0]!, items[1]!, items[2]!, items[3]!];

    corpusPath = tmp();
    await Bun.write(corpusPath, JSON.stringify([
      { id: 101, ja: "文A", en: "sentence A", author: "someone",
        items: [target.id, ctxA.id], ambiguous: [ctxB.id] },
      // A second, longer sentence for the same target, so rotation has a choice
      // and ordering (shortest first) is observable.
      { id: 102, ja: "文Bです", en: "sentence B", author: null,
        items: [target.id, ctxA.id, ctxB.id, outsider.id], ambiguous: [] },
      // ctxA is only ever a context word here — never targetable.
      { id: 103, ja: "文C", en: "sentence C", author: null,
        items: [outsider.id], ambiguous: [ctxA.id] },
    ]));
    await importSentences(db, corpusPath);
  });

  test("import loads sentences, links and n_unheard from the current cards", () => {
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sentences").get()!.n).toBe(3);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sentence_items").get()!.n)
      .toBe(3 + 4 + 2);
    // Nothing is known by ear yet, so every word is unheard.
    expect(db.query<{ id: number; n_items: number; n_unheard: number }, []>(
      "SELECT id, n_items, n_unheard FROM sentences ORDER BY id").all())
      .toEqual([{ id: 101, n_items: 3, n_unheard: 3 },
                { id: 102, n_items: 4, n_unheard: 4 },
                { id: 103, n_items: 2, n_unheard: 2 }]);
  });

  test("import refuses a corpus built against a different bank", async () => {
    const bad = tmp();
    await Bun.write(bad, JSON.stringify([
      { id: 1, ja: "x", en: "x", author: null, items: [999_999], ambiguous: [] }]));
    // Silently skipping would serve a sentence whose OTHER ids are equally
    // shifted — wrong, not merely incomplete.
    await expect(importSentences(db, bad)).rejects.toThrow(/not in the bank/);
    // ...and the refusal must not have wiped the good import.
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sentences").get()!.n).toBe(3);
  });

  test("no sentence is eligible while the context is unknown", () => {
    expect(pickSentence(db, target.id, false, mulberry(1))).toBeNull();
    expect(pickSentence(db, target.id, true, mulberry(1))).toBeNull();
  });

  test("target unknown needs n_unheard = 1; knowing the target alone is not enough", () => {
    markHeard(db, ctxA.id);
    markHeard(db, ctxB.id);
    recomputeUnheard(db);

    // 101 now has exactly one unheard word, which must be the target.
    const s = pickSentence(db, target.id, false, mulberry(1));
    expect(s?.id).toBe(101);
    expect(s?.itemIds.sort()).toEqual([target.id, ctxA.id, ctxB.id].sort());
    // The same sentence is NOT eligible under the target-known rule: n_unheard
    // is 1, and a known target would mean some context word is still unheard.
    expect(pickSentence(db, target.id, true, mulberry(1))).toBeNull();
    // 102 has both `target` and `outsider` unheard (n_unheard = 2), so it is
    // out under either rule; 103 has only `outsider` unheard, so it is exactly
    // i+1 for `outsider`.
    expect(pickSentence(db, outsider.id, false, mulberry(1))?.id).toBe(103);
    expect(pickSentence(db, outsider.id, true, mulberry(1))).toBeNull();
  });

  test("ambiguous words are context only, never a target", () => {
    // ctxA is ambiguous in 103 and certain in 101/102 — but 101/102 are not
    // eligible for it, so it must not be offered sentence 103 as a target.
    expect(pickSentence(db, ctxA.id, true, mulberry(1))?.id).not.toBe(103);
  });

  test("target known requires every word heard, and rotation prefers shorter", () => {
    markHeard(db, target.id);
    markHeard(db, outsider.id);
    recomputeUnheard(db);
    const picked = new Set<number>();
    for (let i = 0; i < 40; i++) picked.add(pickSentence(db, target.id, true, mulberry(i))!.id);
    expect([...picked].sort()).toEqual([101, 102]);
  });

  test("coverage reports what is actually available", () => {
    db.query("UPDATE cards SET introduced=1 WHERE mode='listening' AND item_id IN (?,?)")
      .run(target.id, outsider.id);
    const cov = sentenceCoverage(db);
    expect(cov.withSentence).toBeGreaterThan(0);
    expect(cov.distinct).toBeGreaterThan(0);
    expect(cov.withSentence).toBeLessThanOrEqual(cov.listening);
  });
});

describe("the question a sentence produces", () => {
  let db: Database;
  let target: Item, ctxA: Item, ctxB: Item;

  beforeAll(async () => {
    db = openDb(":memory:");
    await seed(db);
    const all = db.query<Item, []>("SELECT * FROM items WHERE level='N5' ORDER BY id").all();
    // Distinct short meanings, so "the distractor was excluded" is observable.
    const seen = new Set<string>();
    const distinct = all.filter((i) => {
      const m = shortMeaning(i.meaning).toLowerCase();
      if (seen.has(m)) return false;
      seen.add(m); return true;
    });
    [target, ctxA, ctxB] = [distinct[0]!, distinct[1]!, distinct[2]!];
    const p = tmp();
    await Bun.write(p, JSON.stringify([{ id: 201, ja: "これはとても長い日本語の文です。", en: "This is a long sentence.",
      author: "x", items: [target.id, ctxA.id], ambiguous: [ctxB.id] }]));
    await importSentences(db, p);
    for (const i of [ctxA.id, ctxB.id]) markHeard(db, i);
    recomputeUnheard(db);
  });

  test("plays the sentence, not the word, and reveals both", () => {
    const s = pickSentence(db, target.id, false, mulberry(1))!;
    const q = buildQuestion(db, target, "listening", false, mulberry(2), s);
    expect(q.audioText).toBe("これはとても長い日本語の文です。");
    expect(q.audioIsStimulus).toBe(true);
    expect(q.sentenceId).toBe(201);
    expect(q.prompt).toBe("");
    expect(q.reveal.startsWith(`${target.expression}【${target.reading}】`)).toBe(true);
    expect(q.reveal).toContain("これはとても長い日本語の文です。");
    expect(q.reveal).toContain("This is a long sentence.");
  });

  test("no distractor is the meaning of a word the learner just heard", () => {
    // A purely random sample is NOT a guard here: a banned gloss is drawn on
    // roughly 1% of calls, so 60 random seeds pass whether or not the exclusion
    // exists (mutation-tested — that is exactly what happened). Find the seeds
    // that DO collide, then assert the exclusion suppresses those.
    const s = pickSentence(db, target.id, false, mulberry(1))!;
    const banned = new Set([ctxA, ctxB].map((i) => shortMeaning(i.meaning).toLowerCase()));
    const colliding = [];
    for (let i = 0; i < 600; i++) {
      if (distractors(db, target, "meaning", 3, mulberry(i)).some((d) => banned.has(d.toLowerCase()))) {
        colliding.push(i);
      }
    }
    // If this ever hits zero the test below is vacuous, so state the premise.
    expect(colliding.length).toBeGreaterThan(0);

    for (const i of colliding) {
      // buildQuestion draws distractors from a fresh rng before shuffling, so
      // the same seed reproduces the same draw — the only difference is the ban.
      const q = buildQuestion(db, target, "listening", false, mulberry(i), s);
      const wrong = q.choices.filter((_, k) => k !== q.answerIndex).map((c) => c.toLowerCase());
      expect({ i, hit: wrong.filter((w) => banned.has(w)) }).toEqual({ i, hit: [] });
      expect(q.choices.length).toBe(4);
    }
  });

  test("the slow-answer threshold scales with how long the audio takes", () => {
    const s = pickSentence(db, target.id, false, mulberry(1))!;
    const sentenceQ = buildQuestion(db, target, "listening", false, mulberry(2), s);
    const wordQ = buildQuestion(db, target, "listening", false, mulberry(2));
    const textQ = buildQuestion(db, target, "meaning", false, mulberry(2));

    expect(slowThresholdFor(textQ)).toBe(SLOW_MS);
    expect(slowThresholdFor(wordQ)).toBeGreaterThan(SLOW_MS);
    expect(slowThresholdFor(sentenceQ)).toBeGreaterThan(slowThresholdFor(wordQ));
    // A correct answer 16s after a 16-character sentence started playing is not
    // a Hard recall; under the old fixed 12s it was.
    expect(ratingFor(true, 16_000, false, slowThresholdFor(sentenceQ))).toBe(3);
    expect(ratingFor(true, 16_000, false, SLOW_MS)).toBe(2);
    // The ceiling still exists.
    expect(ratingFor(true, 999_000, false, slowThresholdFor(sentenceQ))).toBe(2);
  });

  test("grade records which stimulus was played", () => {
    const s = pickSentence(db, target.id, false, mulberry(1))!;
    const q = buildQuestion(db, target, "listening", false, mulberry(2), s);
    grade(db, q, q.answerIndex, 1000, { now: 1_000_000, rng: mulberry(3) });
    expect(db.query<{ sentence_id: number | null }, []>(
      "SELECT sentence_id FROM reviews ORDER BY id DESC LIMIT 1").get()!.sentence_id).toBe(201);

    const wordQ = buildQuestion(db, target, "listening", false, mulberry(2));
    grade(db, wordQ, wordQ.answerIndex, 1000, { now: 1_100_000, rng: mulberry(3) });
    expect(db.query<{ sentence_id: number | null }, []>(
      "SELECT sentence_id FROM reviews ORDER BY id DESC LIMIT 1").get()!.sentence_id).toBeNull();
  });
});

describe("n_unheard is maintained at graduation", () => {
  let db: Database;
  let target: Item, other: Item;

  beforeAll(async () => {
    db = openDb(":memory:");
    await seed(db);
    const all = db.query<Item, []>("SELECT * FROM items ORDER BY id").all();
    [target, other] = [all[0]!, all[1]!];
    const p = tmp();
    await Bun.write(p, JSON.stringify([{ id: 301, ja: "文", en: "s", author: null,
      items: [target.id, other.id], ambiguous: [] }]));
    await importSentences(db, p);
  });

  const unheard = () =>
    db.query<{ n: number }, []>("SELECT n_unheard AS n FROM sentences WHERE id=301").get()!.n;

  test("the first review does NOT decrement — that is introduction, not graduation", () => {
    const q = buildQuestion(db, target, "listening", true, mulberry(1));
    grade(db, q, q.answerIndex, 500, { now: 2_000_000, rng: mulberry(1) });
    // introduced is now 1, but the card is still on learning step 1 of 2.
    expect(db.query<{ introduced: number; state: string }, [number]>(
      "SELECT introduced, state FROM cards WHERE item_id=? AND mode='listening'").get(target.id))
      .toEqual({ introduced: 1, state: "learning" });
    expect(unheard()).toBe(2);
  });

  test("leaving initial learning decrements exactly once", () => {
    const q = buildQuestion(db, target, "listening", false, mulberry(1));
    // Rating 3 walks step 1 -> review (learningSteps has two steps).
    grade(db, q, q.answerIndex, 500, { now: 2_600_000, rng: mulberry(2) });
    expect(db.query<{ state: string }, [number]>(
      "SELECT state FROM cards WHERE item_id=? AND mode='listening'").get(target.id)!.state)
      .toBe("review");
    expect(unheard()).toBe(1);

    // Further correct reviews must not decrement again.
    grade(db, q, q.answerIndex, 500, { now: 90_000_000, rng: mulberry(3) });
    expect(unheard()).toBe(1);
  });

  test("a lapse does not re-increment — relearning still counts as heard", () => {
    const q = buildQuestion(db, target, "listening", false, mulberry(1));
    grade(db, q, (q.answerIndex + 1) % 4, 500, { now: 900_000_000, rng: mulberry(4) });
    expect(db.query<{ state: string }, [number]>(
      "SELECT state FROM cards WHERE item_id=? AND mode='listening'").get(target.id)!.state)
      .toBe("relearning");
    expect(unheard()).toBe(1);
    // ...and recovering from the lapse must not decrement a second time.
    grade(db, q, q.answerIndex, 500, { now: 900_600_000, rng: mulberry(5) });
    expect(unheard()).toBe(1);
  });

  test("only listening graduations count", () => {
    const before = unheard();
    for (const mode of ["meaning", "production"] as Mode[]) {
      const q = buildQuestion(db, other, mode, true, mulberry(6));
      for (let i = 0; i < 4; i++) {
        grade(db, q, mode === "production" ? q.answer : q.answerIndex, 500,
          { now: 1_000_000_000 + i * 700_000, rng: mulberry(i) });
      }
    }
    expect(db.query<{ state: string }, [number]>(
      "SELECT state FROM cards WHERE item_id=? AND mode='meaning'").get(other.id)!.state).toBe("review");
    expect(unheard()).toBe(before);
  });

  test("grade is atomic: a failed write leaves the card untouched", () => {
    // The counter is monotone, so a card update that lands while the counter
    // update does not is permanent, silent drift. Force the middle statement to
    // fail and assert nothing survived it.
    const q = buildQuestion(db, target, "listening", false, mulberry(1));
    const before = db.query<{ due: number; state: string; last_review: number | null }, [number]>(
      "SELECT due, state, last_review FROM cards WHERE item_id=? AND mode='listening'").get(target.id);
    const unheardBefore = unheard();

    db.exec(`CREATE TRIGGER boom AFTER INSERT ON reviews
             WHEN NEW.elapsed_ms = 66613 BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    try {
      expect(() => grade(db, q, q.answerIndex, 66613, { now: 2_000_000_000, rng: mulberry(7) }))
        .toThrow();
    } finally {
      db.exec("DROP TRIGGER boom");
    }

    expect(db.query<{ due: number; state: string; last_review: number | null }, [number]>(
      "SELECT due, state, last_review FROM cards WHERE item_id=? AND mode='listening'").get(target.id))
      .toEqual(before!);
    expect(unheard()).toBe(unheardBefore);
    expect(db.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM reviews WHERE elapsed_ms = 66613").get()!.n).toBe(0);
  });

  test("the incremental counter agrees with a full recompute", () => {
    expect(unheardDrift(db)).toEqual([]);
  });

  test("decrementUnheardFor never goes below zero", () => {
    for (let i = 0; i < 5; i++) decrementUnheardFor(db, target.id);
    expect(unheard()).toBe(0);
    decrementUnheardFor(db, target.id);
    expect(unheard()).toBe(0);
  });
});

describe("the counter survives a realistic run", () => {
  test("no drift after 300 graded questions with the real corpus", async () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "jlpt-run-")), "r.db"));
    await seed(db);
    setSetting(db, "new_per_day", "40");
    setSetting(db, "mode_weights", "listening:70,reading:10,production:10,meaning:10");
    setSetting(db, SENTENCE_SETTING, "1");
    await importSentences(db);

    const rng = mulberry(4242);
    let served = 0, withSentence = 0;
    for (let day = 1; day <= 30; day++) {
      const t0 = day * 86_400_000;
      for (let k = 0; k < 60; k++) {
        const q = nextQuestion(db, { now: t0, rng });
        if (!q) break;
        served++;
        if (q.sentenceId !== undefined) withSentence++;
        const ok = rng() < 0.9;
        const response = q.mode === "production"
          ? (ok ? q.answer : "ぜったいちがう")
          : String(ok ? q.answerIndex : (q.answerIndex + 1) % 4);
        grade(db, q, response, 1500, { now: t0 + k * 1000, rng });
      }
    }
    expect(served).toBeGreaterThan(300);
    // The premise: real sentences do get served under the real scheduler.
    expect(withSentence).toBeGreaterThan(0);
    // Every eligible sentence must contain the target as a certain (not
    // ambiguous) word — the whole i+1 claim rests on this.
    const bad = db.query<{ n: number }, []>(`
      SELECT COUNT(*) AS n FROM reviews r
       WHERE r.sentence_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM sentence_items si
                          WHERE si.sentence_id = r.sentence_id
                            AND si.item_id = r.item_id AND si.ambiguous = 0)`).get()!.n;
    expect(bad).toBe(0);
    expect(unheardDrift(db)).toEqual([]);
    db.close();
  }, 120_000);

  test("the mock-exam path never serves a sentence", async () => {
    const db = openDb(":memory:");
    await seed(db);
    setSetting(db, SENTENCE_SETTING, "1");
    await importSentences(db);
    // Make a large slice of the bank known by ear so sentences ARE available.
    db.query("UPDATE cards SET introduced=1, state='review' WHERE mode='listening'").run();
    recomputeUnheard(db);
    expect(sentenceCoverage(db).withSentence).toBeGreaterThan(0);

    // Force a card that definitely HAS an eligible sentence to the front of the
    // queue: comparing the two paths only means something on the same card.
    const targetable = db.query<{ item_id: number }, []>(`
      SELECT si.item_id FROM sentence_items si JOIN sentences s ON s.id = si.sentence_id
       WHERE si.ambiguous = 0 AND s.n_unheard = 0 LIMIT 1`).get()!.item_id;
    db.query("UPDATE cards SET due = 0 WHERE item_id = ? AND mode = 'listening'").run(targetable);

    const rng = mulberry(9);
    const opts = { mode: "listening" as const, newLimit: 0, now: 10 ** 12, rng };
    for (let i = 0; i < 25; i++) {
      expect(nextQuestion(db, { ...opts, sentences: false })?.itemId).toBe(targetable);
      expect(nextQuestion(db, { ...opts, sentences: false })?.sentenceId).toBeUndefined();
    }
    // ...while the study path serves one on that very card.
    let any = false;
    for (let i = 0; i < 25; i++) if (nextQuestion(db, opts)?.sentenceId) any = true;
    expect(any).toBe(true);
    db.close();
  }, 60_000);
});

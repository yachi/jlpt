import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, MODES, MODE_SECTION, setSetting } from "./db";
import { seed, parseCsv, shortMeaning, distractors, type Item } from "./bank";
import { buildQuestion, checkAnswer, grade, nextQuestion, ratingFor, normalize, humanInterval } from "./quiz";
import { synthesize } from "./tts";

const db = openDb(join(mkdtempSync(join(tmpdir(), "jlpt-")), "t.db"));
let items: Item[];

beforeAll(async () => {
  await seed(db);
  items = db.query<Item, []>("SELECT * FROM items ORDER BY id").all();
});

// deterministic RNG so shuffles/distractors are reproducible
const mulberry = (seed: number) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe("CSV parsing", () => {
  test("handles quoted fields containing commas", () => {
    const rows = parseCsv('a,b\n"x, y",z\n');
    expect(rows[1]).toEqual(["x, y", "z"]);
  });
  test("handles escaped double quotes", () => {
    expect(parseCsv('h\n"say ""hi"""\n')[1]).toEqual(['say "hi"']);
  });
  test("shortMeaning does not split on separators inside brackets", () => {
    expect(shortMeaning("to dial/call (e.g., a telephone number), to ring")).toBe("to dial/call (e.g., a telephone number)");
    expect(shortMeaning("blue")).toBe("blue");
    expect(shortMeaning("to meet, to see")).toBe("to meet");
    expect(shortMeaning("a [thing, other]; b")).toBe("a [thing, other]");
    expect(shortMeaning(", leading comma")).toBe(", leading comma");
  });

  test("no choice text in the whole bank ends mid-bracket", () => {
    // Guards the class of bug, not just the one instance we happened to see.
    const bad = items
      .map((i) => shortMeaning(i.meaning))
      .filter((m) => {
        let d = 0;
        for (const c of m) { if ("([{".includes(c)) d++; else if (")]}".includes(c)) d--; }
        return d !== 0;
      });
    expect(bad, `unbalanced glosses: ${bad.slice(0, 5).join(" | ")}`).toHaveLength(0);
  });

  test("real item bank loaded both levels", () => {
    const n5 = items.filter((i) => i.level === "N5").length;
    const n4 = items.filter((i) => i.level === "N4").length;
    expect(n5).toBeGreaterThan(600);
    expect(n4).toBeGreaterThan(600);
  });
});

describe("question construction", () => {
  test("every mode produces a self-consistent question", () => {
    const item = items.find((i) => i.has_kanji === 1)!;
    for (const mode of MODES) {
      const q = buildQuestion(db, item, mode, false, mulberry(7));
      expect(q.section).toBe(MODE_SECTION[mode]);
      if (mode === "production") {
        expect(q.choices).toHaveLength(0);
        expect(q.answerIndex).toBe(-1);
      } else {
        expect(q.choices).toHaveLength(4);
        expect(q.choices[q.answerIndex]).toBe(q.answer);
        expect(new Set(q.choices).size, `${mode} has duplicate choices`).toBe(4);
      }
    }
  });

  test("the correct choice is not always in the same position", () => {
    const positions = new Set<number>();
    for (let i = 0; i < 60; i++) {
      positions.add(buildQuestion(db, items[i]!, "meaning", false, mulberry(i)).answerIndex);
    }
    expect(positions.size).toBeGreaterThan(1);
  });

  test("distractors never equal the correct answer", () => {
    for (const item of items.slice(0, 200)) {
      for (const field of ["meaning", "reading"] as const) {
        const d = distractors(db, item, field, 3, mulberry(item.id));
        const correct = field === "meaning" ? shortMeaning(item.meaning) : item.reading;
        expect(d).not.toContain(correct);
        expect(new Set(d).size).toBe(d.length);
      }
    }
  });

  test("the kana reading is shown ONLY on meaning cards", () => {
    // On `reading` the kana IS the answer; on `production` it is what you type.
    // Leaking it into either would make the card free.
    const kanjiItems = items.filter((i) => i.has_kanji === 1).slice(0, 150);
    for (const item of kanjiItems) {
      for (const mode of MODES) {
        const q = buildQuestion(db, item, mode, false, mulberry(item.id));
        if (mode === "meaning") {
          expect(q.promptReading, `${item.expression} meaning`).toBe(item.reading);
        } else {
          expect(q.promptReading, `${item.expression} ${mode} leaked the reading`).toBeUndefined();
        }
      }
    }
  });

  test("kana-only words show no redundant reading", () => {
    const kana = items.find((i) => i.has_kanji === 0 && i.expression === i.reading)!;
    expect(buildQuestion(db, kana, "meaning", false, mulberry(1)).promptReading).toBeUndefined();
  });

  test("listening questions carry audio and show no text prompt", () => {
    const q = buildQuestion(db, items[0]!, "listening", false, mulberry(1));
    expect(q.prompt).toBe("");
    expect(q.audioText).toBeTruthy();
  });

  test("reading cards are never created for kana-only words", () => {
    const kanaOnly = db.query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM cards c JOIN items i ON i.id=c.item_id
        WHERE c.mode='reading' AND i.has_kanji=0`).get()!.n;
    expect(kanaOnly).toBe(0);
  });
});

describe("grading", () => {
  test("MC grading compares against the shuffled index, not the text", () => {
    const q = buildQuestion(db, items[3]!, "meaning", false, mulberry(3));
    expect(checkAnswer(q, q.answerIndex)).toBe(true);
    expect(checkAnswer(q, (q.answerIndex + 1) % 4)).toBe(false);
  });

  test("production accepts kana, the written form, and full-width input", () => {
    const item = items.find((i) => i.has_kanji === 1 && !/[～~]/.test(i.expression))!;
    const q = buildQuestion(db, item, "production", false, mulberry(5));
    expect(checkAnswer(q, item.reading)).toBe(true);
    expect(checkAnswer(q, item.expression)).toBe(true);
    expect(checkAnswer(q, ` ${item.reading} `)).toBe(true);
    expect(checkAnswer(q, "ぜったいちがう")).toBe(false);
  });

  test("normalize folds width and strips the ~ placeholder", () => {
    expect(normalize("～ＡＢ ")).toBe("ab");
  });

  test("rating mapping: wrong=1, slow=2, normal=3, easy=4", () => {
    expect(ratingFor(false, 100)).toBe(1);
    expect(ratingFor(true, 20_000)).toBe(2);
    expect(ratingFor(true, 2_000)).toBe(3);
    expect(ratingFor(true, 2_000, true)).toBe(4);
  });
});

describe("scheduling integration", () => {
  test("a wrong answer schedules sooner than a right one", () => {
    const qa = buildQuestion(db, items[10]!, "meaning", true, mulberry(11));
    const qb = buildQuestion(db, items[11]!, "meaning", true, mulberry(12));
    const now = Date.parse("2026-03-01T00:00:00Z");
    const wrong = grade(db, qa, (qa.answerIndex + 1) % 4, 1000, { now });
    const right = grade(db, qb, qb.answerIndex, 1000, { now });
    expect(wrong.correct).toBe(false);
    expect(right.correct).toBe(true);
    expect(wrong.nextDue).toBeLessThan(right.nextDue);
  });

  test("a graded card leaves the new queue and is logged", () => {
    const q = buildQuestion(db, items[20]!, "meaning", true, mulberry(21));
    grade(db, q, q.answerIndex, 500, { now: Date.now() });
    const card = db.query<{ introduced: number }, [number, string]>(
      "SELECT introduced FROM cards WHERE item_id=? AND mode=?").get(q.itemId, "meaning")!;
    expect(card.introduced).toBe(1);
    const n = db.query<{ n: number }, [number]>(
      "SELECT COUNT(*) AS n FROM reviews WHERE item_id=?").get(q.itemId)!.n;
    expect(n).toBeGreaterThanOrEqual(1);
  });

  test("repeated correct answers produce strictly growing intervals", () => {
    const q = buildQuestion(db, items[30]!, "meaning", true, mulberry(31));
    let now = Date.parse("2026-03-01T00:00:00Z");
    const intervals: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = grade(db, q, q.answerIndex, 800, { now, rng: () => 0.5 });
      intervals.push(r.nextDue - now);
      now = r.nextDue;
    }
    // Ignore the short learning steps; once in review, intervals must expand.
    const reviewPhase = intervals.slice(2);
    for (let i = 1; i < reviewPhase.length; i++) {
      expect(reviewPhase[i]!).toBeGreaterThan(reviewPhase[i - 1]!);
    }
  });

  test("the daily new-card limit is enforced", () => {
    const fresh = openDb(join(mkdtempSync(join(tmpdir(), "jlpt-lim-")), "t.db"));
    return seed(fresh).then(() => {
      setSetting(fresh, "new_per_day", "3");
      const now = Date.parse("2026-04-01T12:00:00Z");
      let introduced = 0;
      for (let i = 0; i < 10; i++) {
        const q = nextQuestion(fresh, { now, rng: mulberry(i) });
        if (!q) break;
        if (q.isNew) introduced++;
        grade(fresh, q, q.answerIndex, 500, { now });
      }
      expect(introduced).toBeLessThanOrEqual(3);
      fresh.close();
    });
  });

  test("new cards do not repeat the same word across modes on the same day", () => {
    const fresh = openDb(join(mkdtempSync(join(tmpdir(), "jlpt-sib-")), "t.db"));
    return seed(fresh).then(() => {
      setSetting(fresh, "new_per_day", "6");
      const now = Date.parse("2026-05-01T09:00:00Z");
      const seenItems: number[] = [];
      for (let i = 0; i < 6; i++) {
        const q = nextQuestion(fresh, { now, rng: mulberry(i) });
        if (!q) break;
        seenItems.push(q.itemId);
        grade(fresh, q, q.answerIndex, 500, { now });
      }
      expect(seenItems.length).toBeGreaterThan(3);
      expect(new Set(seenItems).size, `repeated words in one day: ${seenItems}`).toBe(seenItems.length);
      fresh.close();
    });
  });

  test("sibling modes DO become available the next day", () => {
    const fresh = openDb(join(mkdtempSync(join(tmpdir(), "jlpt-sib2-")), "t.db"));
    return seed(fresh).then(() => {
      setSetting(fresh, "new_per_day", "2");
      const day1 = Date.parse("2026-05-01T09:00:00Z");
      const first = nextQuestion(fresh, { now: day1, rng: mulberry(1) })!;
      grade(fresh, first, first.answerIndex, 500, { now: day1 });

      // 24h later the same word's other modes are no longer deprioritised away.
      // The cooldown is keyed on the word's LAST review, so a day later its other
      // modes are reachable again. (Ask for 'listening' specifically so the day-1
      // 'meaning' card's own review doesn't win the queue and re-arm the cooldown.)
      const day2 = day1 + 24 * 3600_000;
      const sibling = nextQuestion(fresh, { now: day2, mode: "listening", rng: mulberry(1) })!;
      expect(sibling.isNew).toBe(true);
      expect(sibling.itemId).toBe(first.itemId);
      expect(sibling.mode).toBe("listening");

      // ...but reviewing that word again today re-arms it: the next NEW card must
      // be a different word.
      grade(fresh, sibling, sibling.answerIndex, 500, { now: day2 });
      const after = nextQuestion(fresh, { now: day2 + 60_000, mode: "production", rng: mulberry(2) })!;
      expect(after.itemId).not.toBe(first.itemId);
      fresh.close();
    });
  });

  test("humanInterval renders each magnitude", () => {
    expect(humanInterval(60_000)).toBe("1m");
    expect(humanInterval(3 * 3_600_000)).toBe("3h");
    expect(humanInterval(5 * 86_400_000)).toBe("5d");
    expect(humanInterval(90 * 86_400_000)).toBe("3.0mo");
    expect(humanInterval(800 * 86_400_000)).toBe("2.2y");
  });
});

describe("TTS cache safety", () => {
  test("a zero-byte cache entry is treated as a miss, not served", async () => {
    // Regression: a synthesis that dies partway used to leave a 0-byte file
    // that every later lookup happily returned as a valid cache hit.
    const text = `キャッシュ試験${Date.now()}`;
    const first = await synthesize(text);
    expect(first).not.toBeNull();
    expect(statSync(first!.path).size).toBeGreaterThan(0);

    writeFileSync(first!.path, "");             // simulate the corrupted entry
    expect(await synthesize(text, { cacheOnly: true })).toBeNull(); // must NOT be a hit

    const repaired = await synthesize(text);    // must re-synthesize
    expect(repaired).not.toBeNull();
    expect(statSync(repaired!.path).size).toBeGreaterThan(0);
    rmSync(repaired!.path, { force: true });
  });

  test("no .part temp files survive a successful synthesis", async () => {
    const text = `一時ファイル試験${Date.now()}`;
    const r = await synthesize(text);
    expect(r).not.toBeNull();
    expect(existsSync(`${r!.path}.part`)).toBe(false);
    rmSync(r!.path, { force: true });
  });
});

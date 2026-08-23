import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, MODES, MODE_SECTION, setSetting } from "./db";
import { seed, parseCsv, shortMeaning, distractors, loadFalseFriends, type Item } from "./bank";
import { buildQuestion, checkAnswer, grade, nextQuestion, ratingFor, normalize, humanInterval,
  parseModeWeights, modePriority, introducedByMode, DEFAULT_MODE_WEIGHTS, hasAudioStimulus } from "./quiz";
import { synthesize, cacheKey, pickMacVoice, pickAzureVoice, pickVoices,
  MACOS_JA_VOICES, AZURE_JA_VOICES } from "./tts";

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

  test("only listening plays before the answer, though meaning also has audio", () => {
    // Two different properties. `meaning` carries audioText for post-answer
    // playback; playing it up front would narrate the word already on screen.
    // The playback path must key off the stimulus flag, never off the mode
    // string — a new audio-bearing mode would otherwise play silence.
    const item = items.find((i) => i.has_kanji === 1)!;
    for (const mode of MODES) {
      const q = buildQuestion(db, item, mode, false, mulberry(3));
      expect({ mode, stimulus: hasAudioStimulus(q) })
        .toEqual({ mode, stimulus: mode === "listening" });
    }
    expect(buildQuestion(db, item, "meaning", false, mulberry(3)).audioText).toBeTruthy();

    const listening = buildQuestion(db, item, "listening", false, mulberry(3));
    expect(hasAudioStimulus({ ...listening, mode: "meaning" })).toBe(true);
    expect(hasAudioStimulus({ ...listening, audioText: "" })).toBe(false);
    expect(hasAudioStimulus({ ...listening, audioIsStimulus: undefined })).toBe(false);
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

  test("production accepts romaji, for anyone typing without a Japanese IME", () => {
    const item = items.find((i) => i.reading === "あし")!;
    const q = buildQuestion(db, item, "production", false, mulberry(5));
    expect(checkAnswer(q, "ashi")).toBe(true);
    expect(checkAnswer(q, "ASHI")).toBe(true);
    expect(checkAnswer(q, "ashe")).toBe(false);
  });

  test("production accepts any one of several written forms", () => {
    // Entries list alternatives in one field ("足; 脚"); each must be accepted
    // on its own, or the answer key is a string no learner would ever type.
    const item = items.find((i) => /[;；/／、]/.test(i.expression))!;
    const q = buildQuestion(db, item, "production", false, mulberry(7));
    for (const form of item.expression.split(/[;；/／、]/).map((s) => s.trim())) {
      expect({ form, ok: checkAnswer(q, form) }).toEqual({ form, ok: true });
    }
  });

  test("an empty answer is wrong, not a match against an empty form", () => {
    const item = items.find((i) => i.has_kanji === 1)!;
    const q = buildQuestion(db, item, "production", false, mulberry(9));
    expect(checkAnswer(q, "")).toBe(false);
    expect(checkAnswer(q, "   ")).toBe(false);

    // The dangerous case: readingKey() drops a leading ー, so a form that is
    // nothing but a prolongation mark folds to "" and would match "" — i.e.
    // submitting nothing would score correct. Filtering empty *forms* does not
    // catch this, because the form is non-empty until it is folded.
    const degenerate = { ...q, answer: "ー", reveal: "ー【ー】— x" };
    expect(checkAnswer(degenerate, "")).toBe(false);
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

  test("skip_meaning_for_kanji drops free meaning cards but keeps false friends", async () => {
    const fresh = openDb(join(mkdtempSync(join(tmpdir(), "jlpt-ff-")), "t.db"));
    await seed(fresh);
    setSetting(fresh, "skip_meaning_for_kanji", "1");
    setSetting(fresh, "new_per_day", "9999");

    const now = Date.parse("2026-06-01T09:00:00Z");
    const seenMeaning: { expr: string; kanji: number }[] = [];
    for (let i = 0; i < 400; i++) {
      const q = nextQuestion(fresh, { now, rng: mulberry(i) });
      if (!q) break;
      if (q.isNew && q.mode === "meaning") {
        const it = fresh.query<{ has_kanji: number }, [number]>(
          "SELECT has_kanji FROM items WHERE id = ?").get(q.itemId)!;
        seenMeaning.push({ expr: q.prompt, kanji: it.has_kanji });
      }
      grade(fresh, q, q.answerIndex, 500, { now });
    }

    // Every kanji-bearing meaning card served must be a listed false friend.
    const kanjiMeaning = seenMeaning.filter((s) => s.kanji === 1).map((s) => s.expr);
    const ff = new Set(fresh.query<{ expression: string }, []>(
      "SELECT expression FROM false_friends").all().map((r) => r.expression));
    const leaked = kanjiMeaning.filter((e) => !ff.has(e));
    expect(leaked, `free meaning cards leaked: ${leaked.slice(0, 5).join(" ")}`).toHaveLength(0);

    // Kana-only words must still get meaning cards — they have no kanji to lean on.
    expect(seenMeaning.some((s) => s.kanji === 0)).toBe(true);
    fresh.close();
  });

  test("false friends are actually reachable as meaning cards", async () => {
    const fresh = openDb(join(mkdtempSync(join(tmpdir(), "jlpt-ff2-")), "t.db"));
    await seed(fresh);
    setSetting(fresh, "skip_meaning_for_kanji", "1");
    const reachable = fresh.query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM cards c JOIN items i ON i.id = c.item_id
        WHERE c.mode = 'meaning' AND i.has_kanji = 1
          AND i.expression IN (SELECT expression FROM false_friends)`).get()!.n;
    expect(reachable).toBeGreaterThan(20);
    fresh.close();
  });

  test("every false-friends.txt entry matches a real item", async () => {
    const fresh = openDb(join(mkdtempSync(join(tmpdir(), "jlpt-ff3-")), "t.db"));
    await seed(fresh);
    const { unmatched } = await loadFalseFriends(fresh);
    expect(unmatched, `typos in false-friends.txt: ${unmatched.join(" ")}`).toHaveLength(0);
    fresh.close();
  });

  test("the sibling-cooldown subquery uses an index, not a table scan", () => {
    // Regression: this correlated subquery runs per candidate row on EVERY
    // `next` call, and `reviews` grows forever. Unindexed it took 27s for 400
    // calls and degraded from there. Asserting the query plan is deterministic;
    // asserting wall-clock would be flaky.
    const plan = db
      .query<{ detail: string }, [number]>(
        "EXPLAIN QUERY PLAN SELECT MAX(r.ts) FROM reviews r WHERE r.item_id = ?")
      .all(1)
      .map((r) => r.detail)
      .join(" | ");
    // Must be a CONSTRAINED lookup on item_id. Asserting merely "USING INDEX"
    // is not enough: without idx_reviews_item, SQLite happily reports
    // "SEARCH r USING INDEX idx_reviews_ts" while traversing the whole index —
    // a full scan wearing a disguise. The "(item_id=?)" term is the real proof.
    expect(plan, `plan was: ${plan}`).toMatch(/\(item_id=/);
  });

  test("parseModeWeights: explicit spec is a complete statement of intent", () => {
    expect(parseModeWeights("")).toEqual(DEFAULT_MODE_WEIGHTS);
    expect(parseModeWeights("listening:50,reading:50"))
      .toEqual({ listening: 50, reading: 50, meaning: 0, production: 0 });
    expect(parseModeWeights("bogus:9")).toEqual(DEFAULT_MODE_WEIGHTS);   // no valid keys
    expect(parseModeWeights("listening:0,reading:0,meaning:0,production:0"))
      .toEqual(DEFAULT_MODE_WEIGHTS);                                     // all-zero is not a mix
    expect(parseModeWeights("listening:-5,reading:10"))
      .toEqual({ listening: 0, reading: 10, meaning: 0, production: 0 }); // negatives rejected
  });

  test("modePriority puts the most-starved mode first", () => {
    const even = { meaning: 10, reading: 10, listening: 10, production: 10 };
    // listening weighted heavily but equally represented -> it is owed the most
    expect(modePriority(even, { listening: 70, meaning: 10, reading: 10, production: 10 })[0])
      .toBe("listening");
    // already over-represented -> it goes last
    expect(modePriority({ meaning: 1, reading: 1, listening: 100, production: 1 },
      { listening: 25, meaning: 25, reading: 25, production: 25 }).at(-1)).toBe("listening");
  });

  test("new-card mix converges on the configured weights", async () => {
    const fresh = openDb(join(mkdtempSync(join(tmpdir(), "jlpt-mix-")), "t.db"));
    await seed(fresh);
    setSetting(fresh, "new_per_day", "9999");
    setSetting(fresh, "mode_weights", "listening:50,reading:25,meaning:15,production:10");

    const now = Date.parse("2026-07-01T09:00:00Z");
    const seen: Record<string, number> = {};
    for (let i = 0; i < 200; i++) {
      const q = nextQuestion(fresh, { now, rng: mulberry(i) });
      if (!q) break;
      if (q.isNew) seen[q.mode] = (seen[q.mode] ?? 0) + 1;
      grade(fresh, q, q.answerIndex, 500, { now });
    }
    const total = Object.values(seen).reduce((a, b) => a + b, 0);
    const share = (m: string) => ((seen[m] ?? 0) / total) * 100;
    expect(total).toBeGreaterThan(50);
    expect(share("listening"), `mix: ${JSON.stringify(seen)}`).toBeGreaterThan(40);
    expect(share("listening")).toBeLessThan(60);
    expect(share("meaning")).toBeLessThan(25);
    fresh.close();
  });

  test("changing weights REPAIRS an existing imbalance, not just future cards", async () => {
    const fresh = openDb(join(mkdtempSync(join(tmpdir(), "jlpt-repair-")), "t.db"));
    await seed(fresh);
    setSetting(fresh, "new_per_day", "9999");
    const now = Date.parse("2026-07-01T09:00:00Z");

    // Phase 1: meaning-only, creating exactly the listening deficit we had.
    setSetting(fresh, "mode_weights", "meaning:100");
    for (let i = 0; i < 40; i++) {
      const q = nextQuestion(fresh, { now, rng: mulberry(i) });
      if (!q) break;
      grade(fresh, q, q.answerIndex, 500, { now });
    }
    const before = introducedByMode(fresh);
    expect(before.listening).toBe(0);

    // Phase 2: switch to an even mix. Listening should be served first to catch up.
    setSetting(fresh, "mode_weights", "");
    const firstTen: string[] = [];
    for (let i = 0; i < 10; i++) {
      const q = nextQuestion(fresh, { now, rng: mulberry(100 + i) });
      if (!q) break;
      if (q.isNew) firstTen.push(q.mode);
      grade(fresh, q, q.answerIndex, 500, { now });
    }
    expect(firstTen.filter((m) => m === "listening").length,
      `first ten after switch: ${firstTen.join(",")}`).toBeGreaterThan(2);
    fresh.close();
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
  // These tests synthesize for real. Pin them to the offline macOS provider:
  // with a key in the environment they would hit the network, spend Azure
  // quota, and — worse — silently test a different code path than on a machine
  // without one. A test whose meaning depends on ambient env is not a test.
  let saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    saved = { key: process.env.AZURE_SPEECH_KEY, region: process.env.AZURE_SPEECH_REGION };
    delete process.env.AZURE_SPEECH_KEY;
    delete process.env.AZURE_SPEECH_REGION;
  });
  afterAll(() => {
    if (saved.key !== undefined) process.env.AZURE_SPEECH_KEY = saved.key;
    if (saved.region !== undefined) process.env.AZURE_SPEECH_REGION = saved.region;
  });

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

  test("each voice gets its own cache entry", async () => {
    // Regression: the cache key hardcoded the voice name, so switching voices
    // replayed the previous voice's clip — silently defeating the whole point
    // of rotating speakers.
    const text = `声試験${Date.now()}`;
    const a = await synthesize(text, { macVoice: "Kyoko" });
    const b = await synthesize(text, { macVoice: "Eddy" });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.path).not.toBe(b!.path);
    expect(a!.voice).toBe("Kyoko");
    expect(b!.voice).toBe("Eddy");
    // A hit must report the voice it was stored under, not the default.
    const hit = await synthesize(text, { macVoice: "Eddy", cacheOnly: true });
    expect(hit).toMatchObject({ provider: "cache", voice: "Eddy", path: b!.path });
    rmSync(a!.path, { force: true });
    rmSync(b!.path, { force: true });
  });

  test("the cache key names the voice, for either provider", () => {
    // The property that matters, tested without a network call: two voices must
    // never collide on one key, or one speaker's clip is served for another.
    const t = "テスト";
    expect(cacheKey(t, "Kyoko", "0%")).not.toBe(cacheKey(t, "Eddy", "0%"));
    expect(cacheKey(t, "ja-JP-NanamiNeural", "0%")).not.toBe(cacheKey(t, "ja-JP-KeitaNeural", "0%"));
    expect(cacheKey(t, "Kyoko", "0%")).not.toBe(cacheKey(t, "Kyoko", "-10%"));
    expect(cacheKey(t, "Kyoko", "0%")).toBe(cacheKey(t, "Kyoko", "0%"));
  });

  test("pickVoices rolls both providers, not just the installed one", () => {
    // Regression guard: rotating only the macOS voice collapsed Azure to a
    // single speaker the moment a key was set.
    const rng = mulberry(23);
    const seen = { voice: new Set<string>(), macVoice: new Set<string>() };
    for (let i = 0; i < 400; i++) {
      const v = pickVoices(rng);
      seen.voice.add(v.voice);
      seen.macVoice.add(v.macVoice);
    }
    expect(seen.voice.size).toBe(AZURE_JA_VOICES.length);
    expect(seen.macVoice.size).toBe(MACOS_JA_VOICES.length);
  });

  test("pickAzureVoice only ever returns a configured voice", () => {
    for (const r of [0, 0.5, 0.999999, 1 - Number.EPSILON]) {
      expect(AZURE_JA_VOICES).toContain(pickAzureVoice(() => r));
    }
  });

  test("pickMacVoice only ever returns a configured voice", () => {
    // Boundary rng values are where an off-by-one index lands on undefined.
    for (const r of [0, 0.5, 0.999999, 1 - Number.EPSILON]) {
      expect(MACOS_JA_VOICES).toContain(pickMacVoice(() => r));
    }
  });

  test("pickMacVoice actually varies across the configured voices", () => {
    // One rng instance — a fresh mulberry per call replays the same first value
    // and would pass this test against a constant-voice implementation.
    const rng = mulberry(11);
    const seen = new Set(Array.from({ length: 400 }, () => pickMacVoice(rng)));
    expect(seen.size).toBe(MACOS_JA_VOICES.length);
  });
});

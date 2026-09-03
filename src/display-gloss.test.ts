/**
 * A card must show a gloss that IDENTIFIES the word, not merely one that is short.
 *
 * Measured before the fix: 157 of 1384 items (11.3%) shared their first gloss
 * clause with a different word, and in 127 of those the source did distinguish
 * them — truncation threw the distinction away. 薄い "thin, weak" and 細い
 * "thin, slender, fine" both showed "thin".
 */
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb } from "./db";
import {
  glossClauses, shortMeaning, displayGloss, glossIndex, distractors, productionPrompt, type Item,
} from "./bank";
import { buildQuestion } from "./quiz";

function bank(rows: [string, string, string][]): Database {
  const db = openDb(":memory:");
  const ins = db.query(
    "INSERT INTO items (level, expression, reading, meaning, has_kanji) VALUES ('N5',?,?,?,1)");
  for (const [e, r, m] of rows) ins.run(e, r, m);
  return db;
}
const it = (db: Database, expr: string) =>
  db.query<Item, [string]>("SELECT * FROM items WHERE expression = ?").get(expr)!;

const COLLIDING: [string, string, string][] = [
  ["薄い", "うすい", "thin, weak"],
  ["細い", "ほそい", "thin, slender, fine"],
  ["赤", "あか", "red"],
  ["赤い", "あかい", "red"],
];

test("glossClauses splits on top-level separators only", () => {
  expect(glossClauses("a, b; c")).toEqual(["a", "b", "c"]);
  expect(glossClauses("to dial (e.g., a number), to ring")).toEqual(["to dial (e.g., a number)", "to ring"]);
  expect(glossClauses("a [x, y]; b")).toEqual(["a [x, y]", "b"]);
  expect(glossClauses("blue")).toEqual(["blue"]);
});

test("shortMeaning is exactly the first clause", () => {
  expect(shortMeaning("thin, weak")).toBe("thin");
  expect(shortMeaning("blue")).toBe("blue");
});

test("a gloss that already identifies the word is left alone", () => {
  const db = bank([["青", "あお", "blue"], ["犬", "いぬ", "dog"]]);
  expect(displayGloss(db, it(db, "青"))).toBe("blue");
  db.close();
});

test("a colliding gloss escalates until it is unique", () => {
  const db = bank(COLLIDING);
  expect(displayGloss(db, it(db, "薄い"))).toBe("thin, weak");
  expect(displayGloss(db, it(db, "細い"))).toBe("thin, slender");   // enough to separate
  db.close();
});

test("escalation stops at the shortest gloss that works", () => {
  // 細い has three clauses; only two are needed, so the third is not shown.
  const db = bank(COLLIDING);
  expect(displayGloss(db, it(db, "細い"))).not.toContain("fine");
  db.close();
});

test("a word whose FULL gloss is identical to another's cannot escalate", () => {
  // 赤 and 赤い are both exactly "red". No gloss separates them; that is
  // productionPrompt's job, via the part-of-speech tag.
  const db = bank(COLLIDING);
  expect(displayGloss(db, it(db, "赤"))).toBe("red");
  expect(displayGloss(db, it(db, "赤い"))).toBe("red");
  db.close();
});

test("distractors are rendered by the SAME rule as the answer", () => {
  // Escalating only the answer would make the longest option the correct one.
  const db = bank([...COLLIDING,
    ...Array.from({ length: 20 }, (_, i) => [`語${i}`, `ご${i}`, `filler ${i}`] as [string, string, string])]);
  const target = it(db, "薄い");
  for (let seed = 0; seed < 200; seed++) {
    let s = seed * 2654435761 + 1;
    const rng = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    const ds = distractors(db, target, "meaning", 3, rng);
    // 細い, if drawn, must appear escalated — never as the bare "thin", which
    // would be indistinguishable from the answer.
    expect(ds).not.toContain("thin");
  }
  db.close();
});

test("MUTATION: the one-clause gloss really did collide", () => {
  const db = bank(COLLIDING);
  const shorts = ["薄い", "細い"].map((e) => shortMeaning(it(db, e).meaning));
  expect(shorts[0]).toBe(shorts[1]);                    // old behaviour: identical
  const displays = ["薄い", "細い"].map((e) => displayGloss(db, it(db, e)));
  expect(displays[0]).not.toBe(displays[1]);            // new behaviour: distinct
  db.close();
});

test("the index is rebuilt when a gloss changes", () => {
  // Stale display glosses would survive a gloss correction and quietly serve
  // the pre-correction text.
  const db = bank([["薄い", "うすい", "thin, weak"], ["細い", "ほそい", "thin, slender"]]);
  expect(displayGloss(db, it(db, "薄い"))).toBe("thin, weak");
  db.query("UPDATE items SET meaning = 'slender, narrow' WHERE expression = '細い'").run();
  expect(displayGloss(db, it(db, "薄い"))).toBe("thin");   // no longer contested
  db.close();
});

test("glossIndex.sharing names every other item with the same display gloss", () => {
  const db = bank(COLLIDING);
  const red = it(db, "赤"), redAdj = it(db, "赤い");
  expect(glossIndex(db).sharing("red", red.id)).toEqual([redAdj.id]);
  expect(glossIndex(db).sharing("thin, weak", it(db, "薄い").id)).toEqual([]);
  db.close();
});

test("productionPrompt still guarantees an answerable prompt", () => {
  const db = bank(COLLIDING);
  const { prompt, alsoAccept } = productionPrompt(db, it(db, "赤い"));
  expect(prompt).toBe("red (い-adjective)");
  expect(alsoAccept).toEqual([]);
  // And the escalated one needs no tag at all any more.
  expect(productionPrompt(db, it(db, "薄い")).prompt).toBe("thin, weak");
  db.close();
});

test("a built question never repeats an option", () => {
  const db = bank([...COLLIDING,
    ...Array.from({ length: 20 }, (_, i) => [`語${i}`, `ご${i}`, `filler ${i}`] as [string, string, string])]);
  for (const expr of ["薄い", "細い", "赤", "赤い"]) {
    for (let seed = 0; seed < 100; seed++) {
      let s = seed * 2654435761 + 1;
      const rng = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
      const q = buildQuestion(db, it(db, expr), "meaning", false, rng);
      expect(new Set(q.choices.map((c) => c.toLowerCase())).size).toBe(q.choices.length);
    }
  }
  db.close();
});

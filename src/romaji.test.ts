import { describe, expect, test } from "bun:test";
import { foldKana, readingKey, romajiToKana } from "./romaji";
import { openDb } from "./db";
import { seed } from "./bank";

describe("romajiToKana", () => {
  test.each([
    ["ashi", "あし"],
    ["asagohan", "あさごはん"],
    ["akeru", "あける"],
    ["ageru", "あげる"],
    ["asatte", "あさって"],       // gemination
    ["kitte", "きって"],
    ["onna", "おんな"],           // n before consonant
    ["shinbun", "しんぶん"],
    ["hon", "ほん"],              // word-final n
    ["denwa", "でんわ"],
    ["kin'youbi", "きんようび"],  // apostrophe splits n from ya/yu/yo
    ["kinyoubi", "きにょうび"],   // ...and without it, ni+yo, as an IME would
    ["matcha", "まっちゃ"],       // tch gemination
    ["gakkou", "がっこう"],
    ["ryokou", "りょこう"],
    ["jitensha", "じてんしゃ"],
    ["tsukue", "つくえ"],
    ["fuyu", "ふゆ"],
    ["chiisai", "ちいさい"],
  ])("%s -> %s", (romaji, kana) => {
    expect(romajiToKana(romaji)).toBe(kana);
  });

  test("variant romanisations reach the same kana", () => {
    for (const [a, b] of [["shi", "si"], ["tsu", "tu"], ["fu", "hu"], ["ji", "zi"],
                          ["sha", "sya"], ["cha", "tya"], ["ja", "jya"]] as const) {
      expect(romajiToKana(a)).toBe(romajiToKana(b));
    }
  });

  test("is a no-op on kana, so it can run on any production input", () => {
    for (const s of ["あし", "コーヒー", "きょう", "ん", "がっこう"]) {
      expect(romajiToKana(s)).toBe(s);
    }
  });

  test("uppercase input is accepted", () => {
    expect(romajiToKana("ASHI")).toBe("あし");
  });

  test("unmatched characters survive instead of vanishing", () => {
    // A silent drop would turn a wrong answer into a shorter wrong answer and
    // could collide with a real reading; keeping the char keeps it wrong.
    expect(romajiToKana("as?i")).toBe("あs?い");
  });
});

describe("foldKana", () => {
  test("katakana folds onto hiragana", () => {
    expect(foldKana("コーヒー")).toBe(foldKana("こおひい"));
  });

  test("prolongation mark expands to the preceding vowel", () => {
    expect(foldKana("ラーメン")).toBe("らあめん");
    expect(foldKana("スーパー")).toBe("すうぱあ");
  });

  test("chained prolongation marks resolve left to right", () => {
    expect(foldKana("アーー")).toBe("あああ");
  });

  test("a leading prolongation mark cannot crash on an empty buffer", () => {
    expect(foldKana("ーあ")).toBe("あ");
  });

  test("long-vowel spellings collapse", () => {
    expect(foldKana("がっこう")).toBe(foldKana("がっこお"));
    expect(foldKana("せんせい")).toBe(foldKana("せんせえ"));
  });

  test("the long-vowel rule is positional, not a literal おう match", () => {
    // The mora before う is こ, not お — a /おう/ replacement would miss this.
    expect(foldKana("がっこう")).toBe("がっこお");
  });
});

describe("readingKey", () => {
  test.each([
    ["koohii", "コーヒー"],
    ["ko-hi-", "コーヒー"],
    ["gakkou", "がっこう"],
    ["gakkoo", "がっこう"],
    ["sensei", "せんせい"],
    ["raamen", "ラーメン"],
    ["terebi", "テレビ"],
  ])("typed %s matches stored %s", (typed, stored) => {
    expect(readingKey(typed)).toBe(readingKey(stored));
  });

  test("distinct words stay distinct", () => {
    // The folding is lossy on purpose; prove it did not lose a real contrast.
    for (const [a, b] of [["あける", "あげる"], ["きって", "きて"],
                          ["おばさん", "おばあさん"], ["しゅじん", "しゅうじん"]] as const) {
      expect(readingKey(a)).not.toBe(readingKey(b));
    }
  });
});

describe("readingKey over the whole bank", () => {
  test("folding does not merge two different N5/N4 readings", async () => {
    const db = openDb(":memory:");
    await seed(db);
    const rows = db.query<{ reading: string }, []>("SELECT DISTINCT reading FROM items").all();

    const byKey = new Map<string, Set<string>>();
    for (const { reading } of rows) {
      const key = readingKey(reading);
      (byKey.get(key) ?? byKey.set(key, new Set()).get(key)!).add(reading);
    }

    // Report the actual collisions rather than a bare count, so a regression
    // says which pair broke.
    const collisions = [...byKey.values()].filter((v) => v.size > 1).map((v) => [...v]);
    expect({ collisions }).toEqual({ collisions: [] });
  });
});

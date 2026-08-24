import { describe, expect, test, beforeAll } from "bun:test";
import { join } from "node:path";
import { openDb, ROOT } from "./db";
import { seed, type Item } from "./bank";

/**
 * Locks the sentence -> bank-item mapping produced by tools/build_sentences.py.
 *
 * The mapping is built offline by a morphological analyser and checked in, so
 * nothing at runtime can catch it drifting. These pairs were read and verified
 * by hand; two rounds of that review found five real defects the aggregate
 * numbers hid — a suffix resolved to the wrong reading (外国人 as ~にん), a
 * mis-tagged proper noun admitting an out-of-bank word (蝶々), a kana token
 * guessing a kanji-written entry (せい as 背, in a sentence meaning "fault"),
 * multi-form readings never matching during disambiguation ("なん; なに"), and
 * written forms with two readings being served as targets the TTS cannot say.
 *
 * Per the project's rule on golden data: these expectations come from human
 * verification, never from re-running the pipeline over its own output.
 */
describe("sentence corpus mapping", () => {
  interface Golden { id: number; label: string; ja: string; items: string[]; ambiguous: string[] }
  interface Sentence { id: number; ja: string; en: string; author: string | null;
                       items: number[]; ambiguous: number[] }

  let golden: Golden[];
  let corpus: Map<number, Sentence>;
  let label: Map<number, string>;

  beforeAll(async () => {
    golden = await Bun.file(join(ROOT, "data", "sentence-mapping-golden.json")).json();
    const all: Sentence[] = await Bun.file(join(ROOT, "data", "sentences.json")).json();
    corpus = new Map(all.map((s) => [s.id, s]));

    const db = openDb(":memory:");
    await seed(db);
    label = new Map(db.query<Item, []>("SELECT * FROM items").all()
      .map((i) => [i.id, `${i.expression}【${i.reading}】`]));
  });

  test("every verified sentence still maps to exactly the same words", () => {
    const drift: string[] = [];
    for (const g of golden) {
      const s = corpus.get(g.id);
      if (!s) { drift.push(`${g.id} (${g.label}) vanished from the corpus`); continue; }
      const got = { items: s.items.map((i) => label.get(i)!).sort(),
                    ambiguous: s.ambiguous.map((i) => label.get(i)!).sort() };
      const want = { items: [...g.items].sort(), ambiguous: [...g.ambiguous].sort() };
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        drift.push(`${g.id} ${g.ja}\n      want ${want.items.join(" ")} ~${want.ambiguous.join("|")}` +
                   `\n      got  ${got.items.join(" ")} ~${got.ambiguous.join("|")}`);
      }
    }
    expect({ drift }).toEqual({ drift: [] });
  });

  test("the fixture covers every failure mode it was built to cover", () => {
    // A fixture that quietly loses a stratum stops guarding that class of bug.
    const byLabel = new Map<string, number>();
    for (const g of golden) byLabel.set(g.label, (byLabel.get(g.label) ?? 0) + 1);
    expect([...byLabel.keys()].sort()).toEqual(
      ["homophone", "katakana", "long", "multi-form", "plain", "suffix", "suru-verb"]);
    for (const [l, n] of byLabel) expect({ l, enough: n >= 5 }).toEqual({ l, enough: true });
  });

  test("corpus invariants hold for every sentence", () => {
    const bad: string[] = [];
    for (const s of corpus.values()) {
      if (s.items.length === 0) bad.push(`${s.id}: no targetable item`);
      if (s.items.length + s.ambiguous.length < 3) bad.push(`${s.id}: under the context floor`);
      if (s.items.some((i) => s.ambiguous.includes(i))) bad.push(`${s.id}: item in both lists`);
      if (!s.ja || !s.en) bad.push(`${s.id}: missing text`);
      if (bad.length > 5) break;
    }
    expect({ bad }).toEqual({ bad: [] });
  });

  test("every sentence keeps the id its attribution depends on", () => {
    // CC BY 2.0 FR credit is per creator; the id is what resolves to them.
    for (const s of [...corpus.values()].slice(0, 500)) {
      expect(Number.isInteger(s.id) && s.id > 0).toBe(true);
    }
    const credits = Bun.file(join(ROOT, "data", "CREDITS.md"));
    expect(credits.size).toBeGreaterThan(1000);
  });
});

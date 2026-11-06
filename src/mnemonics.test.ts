import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseCsv } from "./bank";
import { hintPolicy, hintRuns, mnemonicFor, mnemonicForReveal, parseMnemonics, plainHint, MATURE_STABILITY_DAYS } from "./mnemonics";

/** A story hint is read in one glance. An on'yomi hint is a formula (word, Jyutping, romaji) and runs longer. */
const HINT_MAX = 20, ON_HINT_MAX = 44;
/** Characters a learner reads: the 【】 marks are display, not text. */
const visibleLength = (hint: string) => [...plainHint(hint)].length;

describe("data/mnemonics.tsv", () => {
  test("every N5 word has a hint, and every hint is well-formed", async () => {
    const index = parseMnemonics(await readFile(new URL("../data/mnemonics.tsv", import.meta.url), "utf8"));
    const rows = parseCsv(await readFile(new URL("../data/n5.csv", import.meta.url), "utf8")).slice(1)
      .filter((r) => r[0] && r[1]).map((r) => ({ expression: r[0]!, reading: r[1]! }));
    const missing = rows.filter((r) => !mnemonicFor(index, r.expression, r.reading)).map((r) => `${r.expression} ${r.reading}`);
    expect(missing).toEqual([]);

    const bad: string[] = [];
    for (const [k, m] of index) {
      const marks = (m.hint.match(/【/g) ?? []).length;
      if (marks !== (m.hint.match(/】/g) ?? []).length) bad.push(`${k}: unbalanced 【】`);
      if (visibleLength(m.hint) > (m.kind === "on" ? ON_HINT_MAX : HINT_MAX)) bad.push(`${k}: ${visibleLength(m.hint)} chars`);
      // A pun is a sound-alike: its keyword is marked, and its Jyutping is on file for checking.
      if ((m.kind === "pun" || m.kind === "en") && marks !== 1) bad.push(`${k}: ${m.kind} without one 【keyword】`);
      if (m.kind === "pun" && !/^[a-z]+[1-6](?: [a-z]+[1-6])*$/.test(m.jyutping)) bad.push(`${k}: jyutping "${m.jyutping}"`);
      if (m.kind === "on" && !/^粵音「.+」[a-z0-9 ]+ ≈ [a-z'-]+$/.test(m.hint)) bad.push(`${k}: on-hint "${m.hint}"`);
    }
    expect(bad).toEqual([]);
  });
});

describe("mnemonics", () => {
  const index = parseMnemonics([
    "expression\treading\tkind\thint\tjyutping",
    "忘れる\tわすれる\tpun\t【華叔嚟】到門口，一拍額頭：忘咗做乜\twaa4 suk1 lai4",
    "約束\tやくそく\ton\t粵音「約束」joek3 cuk1 ≈ yaku-soku\tjoek3 cuk1",
    "アパート\tアパート\tloan\t英文 apartment\t",
    "壊\tbroken\tnope\tx\t",
  ].join("\n"));

  test("keys by expression + reading, ignores the header and unknown kinds", () => {
    expect(mnemonicFor(index, "忘れる", "わすれる")?.kind).toBe("pun");
    expect(mnemonicFor(index, "忘れる", "わすれ")).toBeUndefined();
    expect(mnemonicFor(index, "壊", "broken")).toBeUndefined();
    expect(mnemonicFor(index, "expression", "reading")).toBeUndefined();
  });

  test("finds the word behind a reveal line", () => {
    expect(mnemonicForReveal(index, "約束【やくそく】— promise\n  例文…")?.kind).toBe("on");
    expect(mnemonicForReveal(index, "no reveal here")).toBeUndefined();
  });

  test("splits the keyword out of the hint", () => {
    expect(hintRuns("【華叔嚟】到門口")).toEqual([{ text: "華叔嚟", keyword: true }, { text: "到門口", keyword: false }]);
    expect(plainHint("【華叔嚟】到門口")).toBe("華叔嚟到門口");
  });

  test("hints open when learning, fold when known, hide while asking", () => {
    expect(hintPolicy("teach")).toBe("open");
    expect(hintPolicy("wrong", null)).toBe("open");
    expect(hintPolicy("wrong", MATURE_STABILITY_DAYS - 1)).toBe("open");
    expect(hintPolicy("wrong", MATURE_STABILITY_DAYS)).toBe("collapsed");
    expect(hintPolicy("right", 2)).toBe("collapsed");
    expect(hintPolicy("asking")).toBe("hidden");
  });
});

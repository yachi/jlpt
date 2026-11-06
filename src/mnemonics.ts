/**
 * Memory hints for the word bank (data/mnemonics.tsv): how to REMEMBER a word,
 * not what it means.
 *
 * Two kinds of hint, chosen per word:
 *   on   The kanji's own Cantonese reading already sounds like the Japanese
 *        on'yomi reading (約束 joek3 cuk1 ≈ yaku-soku): both descend from Middle
 *        Chinese, so the hint is the correspondence itself and teaches a rule
 *        that transfers to hundreds of words.
 *   pun  A Cantonese sound-alike for the word's stem, wrapped in 【】, inside one
 *        short scene where the sound-alike and the meaning act on each other
 *        (keyword method; Atkinson & Raugh 1975). Every keyword is checked
 *        against Jyutping by tools/mnemonic-candidates.ts, and the Jyutping is
 *        stored beside the hint so a reader can check it too.
 *   loan A katakana loanword: the source word.
 *   en   An English sound-alike, for the few stems no Cantonese keyword covers.
 *
 * Display-only, like cantonese.tsv: keyed by the CSV's expression + reading,
 * never seeded into study.db, so correcting a hint never touches progress.
 *
 * The hints are shown when a word is LEARNED, never while it is being tested:
 * on the teach card and after a miss, so recall is of the word and not of the
 * hint. See hintPolicy().
 */
export type MnemonicKind = "on" | "pun" | "loan" | "en";

export interface Mnemonic { kind: MnemonicKind; hint: string; jyutping: string }

export type MnemonicIndex = ReadonlyMap<string, Mnemonic>;

const KINDS = new Set<string>(["on", "pun", "loan", "en"]);
const key = (expression: string, reading: string) => `${expression}\t${reading}`;

export function parseMnemonics(tsv: string): MnemonicIndex {
  const out = new Map<string, Mnemonic>();
  for (const line of tsv.split("\n")) {
    const [expression, reading, kind, hint, jyutping = ""] = line.replace(/\r$/, "").split("\t");
    if (!expression || reading === undefined || !kind || !hint || !KINDS.has(kind) || expression === "expression") continue;
    out.set(key(expression, reading), { kind: kind as MnemonicKind, hint, jyutping });
  }
  return out;
}

export function mnemonicFor(index: MnemonicIndex, expression: string, reading: string): Mnemonic | undefined {
  return index.get(key(expression, reading));
}

/**
 * The hint for a Question.reveal ("expr【reading】— meaning", maybe followed by
 * sentence lines): the only handle on the word the CLI has after grading.
 */
export function mnemonicForReveal(index: MnemonicIndex, reveal: string): Mnemonic | undefined {
  const m = reveal.split("\n")[0]!.match(/^(.+?)【(.+?)】— /);
  return m ? mnemonicFor(index, m[1]!, m[2]!) : undefined;
}

/** Hint text split at the 【keyword】 marks: `{ text, keyword }` runs, in order. */
export function hintRuns(hint: string): { text: string; keyword: boolean }[] {
  const runs: { text: string; keyword: boolean }[] = [];
  for (const part of hint.split(/(【[^】]*】)/)) {
    if (!part) continue;
    if (part.startsWith("【") && part.endsWith("】")) runs.push({ text: part.slice(1, -1), keyword: true });
    else runs.push({ text: part, keyword: false });
  }
  return runs;
}

/** The hint as plain text, marks removed (for the CLI and speech). */
export const plainHint = (hint: string) => hint.replaceAll("【", "").replaceAll("】", "");

/**
 * A hint that is shown every time becomes a crutch: recall routes through the
 * story instead of the word. Once a card is stable for this long, even a miss
 * no longer unfolds the hint on its own; it stays one tap away.
 */
export const MATURE_STABILITY_DAYS = 21;

export type HintPolicy = "open" | "collapsed" | "hidden";

/**
 * How a hint is shown at each moment.
 *   teach   first sight of the word: open, this is the moment to encode it.
 *   wrong   after a miss: open while the card is young, collapsed once mature.
 *   right   after a correct answer: collapsed, one tap away.
 *   asking  while the question is open: hidden, a hint before the answer
 *           turns a recall into a recognition.
 */
export function hintPolicy(
  moment: "teach" | "wrong" | "right" | "asking", stabilityDays: number | null = null,
): HintPolicy {
  switch (moment) {
    case "teach": return "open";
    case "wrong": return stabilityDays !== null && stabilityDays >= MATURE_STABILITY_DAYS ? "collapsed" : "open";
    case "right": return "collapsed";
    case "asking": return "hidden";
  }
}

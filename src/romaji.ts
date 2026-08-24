/**
 * Romaji input support for production cards.
 *
 * Typing kana requires a Japanese IME. Without one the whole `production` mode
 * — a quarter of the bank — is unanswerable, so accept Hepburn romaji as well.
 *
 * Two independent pieces:
 *   romajiToKana  ASCII -> hiragana. Non-ASCII passes through untouched, so it
 *                 is safe to run on input that is already kana.
 *   foldKana      collapses the ways the same sound gets written, so that a
 *                 romaji round-trip can be compared against the stored reading.
 */

/** Longest-first so that 3-char digraphs win over their 2-char prefixes. */
const SYLLABLES: Record<string, string> = {
  // youon
  kya: "きゃ", kyu: "きゅ", kyo: "きょ", gya: "ぎゃ", gyu: "ぎゅ", gyo: "ぎょ",
  sha: "しゃ", shu: "しゅ", sho: "しょ", sya: "しゃ", syu: "しゅ", syo: "しょ",
  ja: "じゃ", ju: "じゅ", jo: "じょ", jya: "じゃ", jyu: "じゅ", jyo: "じょ",
  zya: "じゃ", zyu: "じゅ", zyo: "じょ",
  cha: "ちゃ", chu: "ちゅ", cho: "ちょ", tya: "ちゃ", tyu: "ちゅ", tyo: "ちょ",
  cya: "ちゃ", cyu: "ちゅ", cyo: "ちょ",
  nya: "にゃ", nyu: "にゅ", nyo: "にょ", hya: "ひゃ", hyu: "ひゅ", hyo: "ひょ",
  bya: "びゃ", byu: "びゅ", byo: "びょ", pya: "ぴゃ", pyu: "ぴゅ", pyo: "ぴょ",
  mya: "みゃ", myu: "みゅ", myo: "みょ", rya: "りゃ", ryu: "りゅ", ryo: "りょ",
  dya: "ぢゃ", dyu: "ぢゅ", dyo: "ぢょ",
  // foreign-sound clusters that show up in katakana readings
  fa: "ふぁ", fi: "ふぃ", fe: "ふぇ", fo: "ふぉ", fyu: "ふゅ",
  va: "ゔぁ", vi: "ゔぃ", vu: "ゔ", ve: "ゔぇ", vo: "ゔぉ",
  ti: "てぃ", di: "でぃ", du: "どぅ", che: "ちぇ", she: "しぇ", je: "じぇ",
  tsa: "つぁ", tse: "つぇ", tso: "つぉ", wi: "うぃ", we: "うぇ", wo: "を",
  // gojuon
  ka: "か", ki: "き", ku: "く", ke: "け", ko: "こ",
  ga: "が", gi: "ぎ", gu: "ぐ", ge: "げ", go: "ご",
  sa: "さ", shi: "し", si: "し", su: "す", se: "せ", so: "そ",
  za: "ざ", ji: "じ", zi: "じ", zu: "ず", ze: "ぜ", zo: "ぞ",
  ta: "た", chi: "ち", tsu: "つ", tu: "つ", te: "て", to: "と",
  da: "だ", de: "で", do: "ど",
  na: "な", ni: "に", nu: "ぬ", ne: "ね", no: "の",
  ha: "は", hi: "ひ", fu: "ふ", hu: "ふ", he: "へ", ho: "ほ",
  ba: "ば", bi: "び", bu: "ぶ", be: "べ", bo: "ぼ",
  pa: "ぱ", pi: "ぴ", pu: "ぷ", pe: "ぺ", po: "ぽ",
  ma: "ま", mi: "み", mu: "む", me: "め", mo: "も",
  ya: "や", yu: "ゆ", yo: "よ",
  ra: "ら", ri: "り", ru: "る", re: "れ", ro: "ろ",
  wa: "わ",
  a: "あ", i: "い", u: "う", e: "え", o: "お",
};

const MAX_SYLLABLE = 3;
const VOWELS = new Set(["a", "i", "u", "e", "o"]);
/** Latin consonants only. Kana must never reach the romaji-shaped rules. */
const ASCII_CONSONANT = /^[b-df-hj-np-tv-z]$/;

/**
 * Convert ASCII Hepburn romaji to hiragana. Characters that are not part of a
 * recognised syllable are copied through verbatim, which makes the function a
 * no-op on kana and keeps a partial failure legible instead of silently empty.
 */
export function romajiToKana(input: string): string {
  const s = input.toLowerCase();
  let out = "";
  let i = 0;

  while (i < s.length) {
    const c = s[i]!;

    // IME convention: an ASCII hyphen types the prolongation mark.
    if (c === "-") { out += "ー"; i += 1; continue; }

    // Syllabic ん: before a consonant, before an apostrophe, or word-final.
    // Checked ahead of the table so that "onna" is おんな, not お + んあ.
    if (c === "n") {
      const next = s[i + 1];
      if (next === "'" || next === "’") { out += "ん"; i += 2; continue; }
      if (next === undefined || (!VOWELS.has(next) && next !== "y")) { out += "ん"; i += 1; continue; }
    }

    // Gemination: a doubled consonant is っ plus the syllable it doubles.
    // "n" is excluded above; "ch" doubles as "tch" (matcha -> まっちゃ).
    //
    // ASCII_CONSONANT, not "not a vowel": this function also runs on input that
    // is ALREADY kana, and every kana is "not an ASCII vowel". Without the
    // ASCII test, a doubled kana matched this rule and became a sokuon —
    // ああ -> っあ, こころ -> っころ, パパ -> っぱ — mangling 39 of the bank's
    // readings and making romaji input impossible for every one of them.
    if (ASCII_CONSONANT.test(c) && c !== "n") {
      if (s[i + 1] === c) { out += "っ"; i += 1; continue; }
      if (c === "t" && s[i + 1] === "c" && s[i + 2] === "h") { out += "っ"; i += 1; continue; }
    }

    let matched = false;
    for (let len = MAX_SYLLABLE; len >= 1; len--) {
      const kana = SYLLABLES[s.slice(i, i + len)];
      if (kana !== undefined) { out += kana; i += len; matched = true; break; }
    }
    if (!matched) { out += c; i += 1; }
  }
  return out;
}

const KATAKANA_START = 0x30a1;
const KATAKANA_END = 0x30f6;
const KANA_OFFSET = 0x60;

/** Vowel class of a hiragana mora, for expanding the ー prolongation mark. */
const VOWEL_OF: Record<string, string> = {};
for (const [row, vowel] of [
  ["あかさたなはまやらわがざだばぱぁゃゎ", "あ"],
  ["いきしちにひみりぎじぢびぴぃ", "い"],
  ["うくすつぬふむゆるぐずづぶぷぅゅゔ", "う"],
  ["えけせてねへめれげぜでべぺぇ", "え"],
  ["おこそとのほもよろごぞどぼぽぉょ", "お"],
] as const) {
  for (const ch of row) VOWEL_OF[ch] = vowel;
}

/**
 * Collapse writing-system differences that do not change pronunciation, so a
 * romaji answer can be compared against the stored reading:
 *   katakana -> hiragana        コーヒー and こーひー compare equal
 *   ー        -> repeated vowel  コーヒー -> こおひい, matching "koohii"
 *   long o/e  -> one spelling    がっこう and がっこお both -> がっこお
 *
 * The long-vowel rule is positional, not literal: う lengthens whatever お-row
 * mora precedes it, so it is こ+う in がっこう that has to fold, and a literal
 * /おう/ replacement would miss every word of that shape.
 *
 * Deliberately lossy — it accepts spellings a native writer would call wrong.
 * For a recall check that is the right trade: the question is whether the
 * learner knows the word, not whether they picked おう over おお. The bank-wide
 * test in romaji.test.ts is what keeps the lossiness from merging two real
 * readings.
 */
export function foldKana(input: string): string {
  let s = "";
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    s += code >= KATAKANA_START && code <= KATAKANA_END
      ? String.fromCodePoint(code - KANA_OFFSET)
      : ch;
  }

  // Expand ー against the mora before it, left to right so that ーー chains work.
  // A leading ー has nothing to lengthen and is dropped.
  let expanded = "";
  for (const ch of s) {
    if (ch === "ー" || ch === "ｰ") {
      const prev = expanded[expanded.length - 1];
      if (prev !== undefined) expanded += VOWEL_OF[prev] ?? "";
    } else {
      expanded += ch;
    }
  }

  let out = "";
  for (const ch of expanded) {
    const prevVowel = out.length > 0 ? VOWEL_OF[out[out.length - 1]!] : undefined;
    if (ch === "う" && prevVowel === "お") out += "お";
    else if (ch === "い" && prevVowel === "え") out += "え";
    else out += ch;
  }
  return out;
}

/** Normalised form used to compare a typed production answer with the key. */
export function readingKey(input: string): string {
  return foldKana(romajiToKana(input));
}

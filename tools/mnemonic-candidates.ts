/**
 * Sound-alike (keyword-method) helper for data/mnemonics.tsv.
 *
 * A Cantonese pun that only sounds right "by ear" is usually wrong: the first
 * draft of this project's hints was checked against Jyutping and none of them
 * matched. This tool keeps the ear out of it. It parses kana into morae, scores
 * each mora against every Jyutping syllable (r->l, y->j, a trailing ku/ki can
 * be absorbed by a -k coda, and so on) and searches rime-cantonese's word lists
 * for candidates, so that an author composes the story from material that is
 * known to match and then verifies the finished phrase.
 *
 *   bun tools/mnemonic-candidates.ts fetch                # download the dictionaries (once)
 *   bun tools/mnemonic-candidates.ts jyutping 華叔嚟 二嫂谷  # read a phrase in Jyutping
 *   bun tools/mnemonic-candidates.ts candidates わすれる     # per-mora syllables + matching words
 *   bun tools/mnemonic-candidates.ts classify n5          # which words the kanji's own Cantonese reading already covers
 *   bun tools/mnemonic-candidates.ts onhints n5           # those words' hints, as mnemonics.tsv lines
 *   bun tools/mnemonic-candidates.ts verify data/mnemonics.tsv   # re-check every pun's Jyutping and fit
 *
 * Dictionaries: rime-cantonese (https://github.com/rime/rime-cantonese), CC BY 4.0,
 * and OpenCC's 新字体 table (Apache-2.0), cached under .cache/rime-cantonese/ and
 * never shipped with the app.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseCsv } from "../src/bank";

const CACHE = new URL("../.cache/rime-cantonese/", import.meta.url);
const FILES = ["jyut6ping3.chars.dict.yaml", "jyut6ping3.words.dict.yaml", "jyut6ping3.phrase.dict.yaml"];
const RAW = "https://raw.githubusercontent.com/rime/rime-cantonese/main/";
// Japanese 新字体 -> traditional, so 医 looks up 醫 and 気 looks up 氣 (OpenCC, Apache-2.0).
const SHINJITAI = "JPShinjitaiCharacters.txt";
const SHINJITAI_RAW = "https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary/" + SHINJITAI;

// ------------------------------------------------------------------ kana -> morae

const KANA: Record<string, string> = {
  あ: "a", い: "i", う: "u", え: "e", お: "o", か: "ka", き: "ki", く: "ku", け: "ke", こ: "ko",
  さ: "sa", し: "shi", す: "su", せ: "se", そ: "so", た: "ta", ち: "chi", つ: "tsu", て: "te", と: "to",
  な: "na", に: "ni", ぬ: "nu", ね: "ne", の: "no", は: "ha", ひ: "hi", ふ: "fu", へ: "he", ほ: "ho",
  ま: "ma", み: "mi", む: "mu", め: "me", も: "mo", や: "ya", ゆ: "yu", よ: "yo",
  ら: "ra", り: "ri", る: "ru", れ: "re", ろ: "ro", わ: "wa", を: "o", ん: "N",
  が: "ga", ぎ: "gi", ぐ: "gu", げ: "ge", ご: "go", ざ: "za", じ: "ji", ず: "zu", ぜ: "ze", ぞ: "zo",
  だ: "da", ぢ: "ji", づ: "zu", で: "de", ど: "do", ば: "ba", び: "bi", ぶ: "bu", べ: "be", ぼ: "bo",
  ぱ: "pa", ぴ: "pi", ぷ: "pu", ぺ: "pe", ぽ: "po", っ: "Q", ー: "-",
};
const SMALL: Record<string, string> = { ゃ: "a", ゅ: "u", ょ: "o", ぁ: "a", ぃ: "i", ぅ: "u", ぇ: "e", ぉ: "o" };

export interface Mora { on: string; v: string; sp?: "N" | "Q"; text: string }

/** Katakana -> hiragana, so loanwords parse too. */
function toHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

export function morae(kana: string): Mora[] {
  const out: Mora[] = [];
  for (const ch of toHiragana(kana)) {
    if (SMALL[ch]) {
      const m = out[out.length - 1]; if (!m || m.sp) continue;
      const on = ["sh", "ch", "j"].includes(m.on) ? m.on : m.on + "y";
      out[out.length - 1] = { on, v: SMALL[ch], text: m.text + ch };
      continue;
    }
    const r = KANA[ch]; if (!r) continue;
    if (r === "N" || r === "Q") { out.push({ on: "", v: "", sp: r, text: ch }); continue; }
    if (r === "-") { const m = out[out.length - 1]; if (m) m.text += ch; continue; }
    out.push({ on: r.slice(0, -1), v: r.slice(-1), text: ch });
  }
  // Long vowels (おう, えい, doubled) fold into the previous mora: a sound-alike
  // cannot encode length anyway, and the hint marks it separately.
  const merged: Mora[] = [];
  for (const m of out) {
    const p = merged[merged.length - 1];
    if (p && !m.sp && !p.sp && m.on === "" && (m.v === p.v || (p.v === "o" && m.v === "u") || (p.v === "e" && m.v === "i"))) {
      p.text += m.text; continue;
    }
    merged.push(m);
  }
  return merged;
}

export const moraRomaji = (m: Mora) => m.sp === "N" ? "n" : m.sp === "Q" ? "'" : m.on + m.v;

// ------------------------------------------------------------------ jyutping syllables

const ONSETS = ["ng", "gw", "kw", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "w", "z", "c", "s", "j"];
export interface Syl { on: string; nuc: string; coda: string; raw: string }

export function parseSyl(s: string): Syl | null {
  s = s.replace(/[1-6]$/, "");
  if (s === "m" || s === "ng") return null;
  let on = ""; for (const o of ONSETS) if (s.startsWith(o)) { on = o; break; }
  let rest = s.slice(on.length), coda = "";
  for (const c of ["ng", "m", "n", "p", "t", "k"]) if (rest.endsWith(c) && rest.length > c.length) { coda = c; rest = rest.slice(0, -c.length); break; }
  return rest ? { on, nuc: rest, coda, raw: s } : null;
}

// ------------------------------------------------------------------ similarity

const ONSET_SIM: Record<string, Record<string, number>> = {
  "": { "": 1, j: 0.5, w: 0.4, h: 0.2 },
  k: { k: 1, g: 0.9, gw: 0.6, kw: 0.6, h: 0.2 }, g: { g: 1, k: 0.8, gw: 0.6, ng: 0.5 },
  s: { s: 1, c: 0.4, z: 0.4 }, sh: { s: 1, c: 0.4, z: 0.4 },
  z: { z: 1, c: 0.6, s: 0.6, j: 0.3 }, j: { z: 1, c: 0.6, j: 0.4, s: 0.4 },
  t: { t: 1, d: 0.9 }, d: { d: 1, t: 0.8 }, ch: { c: 1, z: 0.7, s: 0.5 }, ts: { c: 1, z: 0.8, s: 0.5 },
  n: { n: 1, l: 0.6 }, h: { h: 1, f: 0.6, "": 0.3 }, f: { f: 1, h: 0.6, w: 0.3 },
  b: { b: 1, p: 0.8, m: 0.3 }, p: { p: 1, b: 0.8 }, m: { m: 1, b: 0.3 },
  y: { j: 1, "": 0.5 }, r: { l: 1, n: 0.3 }, w: { w: 1, "": 0.5, gw: 0.3 },
  ky: { k: 0.8, g: 0.7, h: 0.3 }, gy: { g: 0.8, k: 0.6 }, ny: { n: 0.8, l: 0.5 }, hy: { h: 0.8, f: 0.4 },
  by: { b: 0.8, p: 0.6 }, py: { p: 0.8, b: 0.6 }, my: { m: 0.8 }, ry: { l: 0.8 },
};
const VOWEL_SIM: Record<string, Record<string, number>> = {
  a: { aa: 1, a: 0.9, ai: 0.5, aai: 0.5, au: 0.4, aau: 0.4, e: 0.3, o: 0.3 },
  i: { i: 1, ei: 0.7, iu: 0.4, ai: 0.2, yu: 0.5 },
  u: { u: 1, ou: 0.9, o: 0.6, yu: 0.7, ui: 0.4, eoi: 0.4, oe: 0.4, eo: 0.4, iu: 0.3 },
  e: { e: 1, ei: 0.9, ai: 0.6, i: 0.3, eoi: 0.3, oe: 0.4, eo: 0.5, aa: 0.2, a: 0.2 },
  o: { o: 1, ou: 0.9, oe: 0.6, eo: 0.6, au: 0.3, u: 0.4, aa: 0.2, a: 0.2 },
};

function moraSyl(m: Mora, sy: Syl): number {
  const on = ONSET_SIM[m.on]?.[sy.on] ?? 0;
  let v = VOWEL_SIM[m.v]?.[sy.nuc] ?? 0;
  if (m.on.length === 2 && m.on.endsWith("y") && ["oe", "eo", "yu", "i"].includes(sy.nuc)) v = Math.max(v, 0.6);
  if (m.on === "y" && m.v === "o" && sy.nuc === "oe") v = 0.8;
  if (m.on === "y" && m.v === "a" && sy.nuc === "oe") v = 0.6;
  return on * 0.45 + v * 0.55;
}

/**
 * A coda can stand in for the next mora: 約 joek covers ya-ku, 線 sin covers
 * se-n. So can the off-glide of a diphthong: 細 sai covers sa-i, 賣 maai ma-i.
 */
function codaAbsorb(coda: string, m: Mora, nucleus = ""): number {
  if (!coda) {
    if (m.sp || m.on !== "") return 0;
    if (m.v === "i" && /i$/.test(nucleus) && nucleus !== "i") return 0.9;
    if (m.v === "u" && /u$/.test(nucleus) && nucleus !== "u" && nucleus !== "yu") return 0.9;
    return 0;
  }
  if (m.sp === "N") return ["n", "ng", "m"].includes(coda) ? 1 : 0;
  if (m.sp === "Q") return ["p", "t", "k"].includes(coda) ? 0.9 : 0;
  if (coda === "k" && ["k", "g"].includes(m.on) && ["u", "i"].includes(m.v)) return 0.9;
  if (coda === "t" && ["ts", "ch", "t", "d"].includes(m.on) && ["u", "i", "o"].includes(m.v)) return 0.85;
  if (coda === "p" && ["p", "b"].includes(m.on) && m.v === "u") return 0.85;
  return 0;
}

/**
 * On'yomi correspondence, not resemblance: both Cantonese and Sino-Japanese
 * readings descend from Middle Chinese, so 病院 beng6 jyun2 ~ byouin is regular
 * (b~by, -ng~long vowel, j~zero, -n~ん) even though it is a poor pun.
 */
const ONSET_ON: Record<string, string[]> = {
  "": ["", "y", "w"], j: ["", "y", "n", "j", "z", "w"], ng: ["g", "", "ny"], h: ["k", "g", "ky", "gy"], f: ["h", "f", "b", "p", "hy", "by"],
  w: ["w", "", "y"], b: ["h", "b", "f", "p", "hy", "by", "py"], p: ["h", "b", "p", "hy", "by"], m: ["m", "b", "my", "by"],
  d: ["t", "d", "ch", "j"], t: ["t", "d", "ch"], n: ["n", "d", "ny", "j"], l: ["r", "ry"], g: ["k", "g", "ky", "gy"], k: ["k", "g", "ky", "gy"],
  z: ["s", "sh", "j", "z", "ch", "ts", "t", "d"], c: ["s", "sh", "ch", "ts", "j", "z", "t"], s: ["s", "sh", "z", "j"],
  gw: ["k", "g", "ky"], kw: ["k", "ky"],
};
function onMoraSyl(m: Mora, sy: Syl): number {
  const on = (ONSET_ON[sy.on] ?? []).includes(m.on) ? 1 : 0;
  const v = Math.max(0.55, VOWEL_SIM[m.v]?.[sy.nuc] ?? 0);
  return on * 0.6 + v * 0.4;
}

export interface Alignment { score: number; groups: Mora[][]; /** per syllable, same order as groups */ groupScores: number[] }

/**
 * Align every mora to the syllables, in order, with no syllable skipped.
 * Score is per mora. "pun" scores resemblance to a Cantonese ear; "on" scores
 * the regular on'yomi correspondence instead.
 */
export function align(ms: Mora[], ss: Syl[], mode: "pun" | "on" = "pun"): Alignment | null {
  const n = ms.length, k = ss.length, NEG = -1e9;
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(k + 1).fill(NEG));
  const from: (readonly [number, number, number] | null)[][] = Array.from({ length: n + 1 }, () => Array(k + 1).fill(null));
  dp[0]![0] = 0;
  const relax = (i: number, j: number, i2: number, j2: number, v: number) => {
    if (dp[i]![j]! + v > dp[i2]![j2]!) { dp[i2]![j2] = dp[i]![j]! + v; from[i2]![j2] = [i, j, v]; }
  };
  for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) {
    if (dp[i]![j] === NEG) continue;
    const m = ms[i]!, sy = ss[j]!;
    if (m.sp) { relax(i, j, i + 1, j + 1, 0.1); continue; }
    const sim = mode === "on" ? onMoraSyl(m, sy) : moraSyl(m, sy);
    // An unabsorbed coda costs; in on'yomi mode -ng is the folded long vowel and free.
    const bare = mode === "on" ? (sy.coda === "ng" || !sy.coda ? 0 : 0.35) : (sy.coda ? (["n", "ng", "m"].includes(sy.coda) ? 0.25 : 0.15) : 0);
    relax(i, j, i + 1, j + 1, sim - bare);
    if (i + 1 < n) {
      const nx = ms[i + 1]!;
      let ab = codaAbsorb(sy.coda, nx, sy.nuc);
      // 十 sap6 ~ juu, 入 jap6 ~ nyuu: a -p coda surfaces as a long u (already folded) or a lone う.
      if (mode === "on" && sy.coda === "p" && nx.on === "" && nx.v === "u") ab = 0.8;
      if (ab) relax(i, j, i + 2, j + 1, sim * 0.9 + ab * 0.6);
    }
  }
  if (dp[n]![k] === NEG) return null;
  const groups: Mora[][] = [], groupScores: number[] = [];
  for (let i = n, j = k; i > 0 || j > 0;) {
    const [pi, pj, v] = from[i]![j]!; groups.unshift(ms.slice(pi, i)); groupScores.unshift(v / (i - pi)); i = pi; j = pj;
  }
  return { score: dp[n]![k]! / n, groups, groupScores };
}

// ------------------------------------------------------------------ dictionaries

export interface Entry { w: string; jp: string; syls: Syl[] }
export interface Dict {
  entries: Entry[]; charJp: Map<string, string[]>; wordJp: Map<string, string>; freq: Map<string, number>;
  /** 新字体 -> traditional character. */
  trad: Map<string, string>;
}

function readDict(name: string): string[] {
  const p = new URL(name, CACHE);
  if (!existsSync(p)) throw new Error(`missing ${name}: run \`bun tools/mnemonic-candidates.ts fetch\` first`);
  const lines: string[] = []; let body = false;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (line === "...") { body = true; continue; }
    if (body && line && !line.startsWith("#")) lines.push(line);
  }
  return lines;
}

export function loadDict(): Dict {
  const entries: Entry[] = []; const seen = new Set<string>();
  const wordJp = new Map<string, string>(); const freq = new Map<string, number>();
  for (const f of FILES.slice(1)) for (const line of readDict(f)) {
    const [w, jp] = line.split("\t"); if (!w || !jp || !/^[㐀-鿿]+$/.test(w)) continue;
    if (!wordJp.has(w)) wordJp.set(w, jp);
    const key = `${w}|${jp}`; if (seen.has(key)) continue; seen.add(key);
    const syls = jp.split(" ").map(parseSyl); if (syls.some((s) => !s) || syls.length > 5) continue;
    entries.push({ w, jp, syls: syls as Syl[] });
    for (const ch of w) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  // A character's unmarked readings are its usual ones; a percentage marks a
  // rarer one. Keep the usual ones, and when a character has only marked
  // readings (會, 行) keep those that are not vanishing.
  const usual = new Map<string, string[]>(), marked = new Map<string, string[]>();
  for (const line of readDict(FILES[0]!)) {
    const [w, jp, pct] = line.split("\t"); if (!w || !jp) continue;
    if (!pct) usual.set(w, [...(usual.get(w) ?? []), jp]);
    else if (parseFloat(pct) >= 20) usual.set(w, [...(usual.get(w) ?? []), jp]);
    else if (parseFloat(pct) >= 3) marked.set(w, [...(marked.get(w) ?? []), jp]);
  }
  const charJp = new Map<string, string[]>(usual);
  for (const [w, jps] of marked) if (!charJp.has(w)) charJp.set(w, jps);
  const trad = new Map<string, string>();
  const tp = new URL(SHINJITAI, CACHE);
  if (existsSync(tp)) for (const line of readFileSync(tp, "utf8").split("\n")) {
    const [jp, t] = line.split("\t"); if (jp && t && !jp.startsWith("#")) trad.set(jp, t.split(" ")[0]!);
  }
  return { entries, charJp, wordJp, freq, trad };
}

/** A Japanese word in the characters Cantonese dictionaries use: 医者 -> 醫者. */
export const toTraditional = (d: Dict, s: string) => [...s].map((c) => d.trad.get(c) ?? c).join("");

/** Jyutping of a phrase: whole-word entries first, then character by character. */
export function phraseJyutping(d: Dict, phrase: string): string[] {
  const out: string[] = [];
  phrase = toTraditional(d, phrase);
  for (let i = 0; i < phrase.length;) {
    let hit = false;
    for (let len = Math.min(6, phrase.length - i); len >= 2; len--) {
      const jp = d.wordJp.get(phrase.slice(i, i + len));
      if (jp) { out.push(...jp.split(" ")); i += len; hit = true; break; }
    }
    if (hit) continue;
    const ch = phrase[i]!; i++;
    if (!/[㐀-鿿]/.test(ch)) continue;
    out.push((d.charJp.get(ch) ?? ["?"]).join("/"));
  }
  return out;
}

// ------------------------------------------------------------------ commands

async function fetchDicts(): Promise<void> {
  mkdirSync(CACHE, { recursive: true });
  const sources: [string, string][] = [...FILES.map((f): [string, string] => [f, RAW + f]), [SHINJITAI, SHINJITAI_RAW]];
  for (const [f, url] of sources) {
    const res = await fetch(url); if (!res.ok) throw new Error(`${f}: ${res.status}`);
    writeFileSync(new URL(f, CACHE), await res.text());
    console.log(`fetched ${f}`);
  }
}

function candidates(d: Dict, kana: string): void {
  const ms = morae(kana);
  const sylChars = new Map<string, string[]>();
  for (const [ch, jps] of d.charJp) for (const jp of jps) {
    const k = jp.replace(/[1-6]$/, ""); sylChars.set(k, [...(sylChars.get(k) ?? []), ch]);
  }
  for (const [k, a] of sylChars) sylChars.set(k, a.sort((x, y) => (d.freq.get(y) ?? 0) - (d.freq.get(x) ?? 0)));
  const allSyls = [...sylChars.keys()].map(parseSyl).filter(Boolean) as Syl[];
  const show = (s: Syl) => `${s.raw}(${(sylChars.get(s.raw) ?? []).slice(0, 4).join("")})`;
  console.log(`\n=== ${kana}  [${ms.map(moraRomaji).join(" ")}]`);
  console.log("-- per mora: syllable(common chars)");
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i]!, nx = ms[i + 1];
    if (m.sp) { console.log(`  ${moraRomaji(m)}: absorbed by a coda`); continue; }
    const one = allSyls.map((s) => ({ s, sc: moraSyl(m, s) - (s.coda ? 0.15 : 0) })).sort((a, b) => b.sc - a.sc).slice(0, 6).map((c) => show(c.s));
    let two = "";
    if (nx) {
      const c2 = allSyls.filter((s) => codaAbsorb(s.coda, nx, s.nuc) > 0).map((s) => ({ s, sc: moraSyl(m, s) })).sort((a, b) => b.sc - a.sc).slice(0, 4).map((c) => show(c.s));
      if (c2.length) two = `   | +${moraRomaji(nx)}: ${c2.join(" ")}`;
    }
    console.log(`  ${moraRomaji(m)}: ${one.join(" ")}${two}`);
  }
  console.log("-- words covering 2+ morae (score >= 0.7)");
  for (let a = 0; a < ms.length; a++) for (let b = a + 2; b <= ms.length; b++) {
    const sub = ms.slice(a, b);
    const res = d.entries.filter((e) => e.syls.length <= sub.length).map((e) => ({ e, s: align(sub, e.syls)?.score ?? -1 }))
      .filter((r) => r.s >= 0.7).sort((x, y) => y.s - x.s || (d.freq.get(y.e.w[0]!) ?? 0) - (d.freq.get(x.e.w[0]!) ?? 0)).slice(0, 6);
    if (res.length) console.log(`  [${sub.map(moraRomaji).join(" ")}] ${res.map((r) => `${r.e.w}(${r.e.jp}) ${r.s.toFixed(2)}`).join("  ")}`);
  }
}

/** The reading to use for a hint: first alternative, without する / particles / tildes. */
export function hintReading(reading: string): string {
  return reading.split(/[;、,/]/)[0]!.replace(/\(.*?\)|（.*?）|[～〜]/g, "").trim();
}

/**
 * Does the word's own Cantonese reading already sound like its Japanese reading?
 * True for most on'yomi words (約束 joek3 cuk1 ~ yakusoku) — the hint is then
 * the correspondence itself, and no pun is needed.
 */
export interface OnMatch { score: number; /** weakest syllable */ min: number; jp: string; romaji: string }

export function onReadingMatch(d: Dict, expression: string, reading: string): OnMatch | null {
  const word = toTraditional(d, expression.replace(/[～〜\(\)（）\s]/g, ""));
  const kanji = [...word].filter((c) => /[\u3400-\u9fff]/.test(c));
  if (!kanji.length || kanji.length !== [...word].length) return null;
  // The word's own dictionary reading first (銀行 ngan4 hong4, not 行 hong2),
  // then every combination of the characters' readings.
  const whole = d.wordJp.get(word);
  const options = kanji.map((c, i) => whole ? [whole.split(" ")[i]!] : (d.charJp.get(c) ?? []));
  if (options.some((o) => !o.length)) return null;
  const ms = morae(hintReading(reading));
  let best: OnMatch | null = null;
  const walk = (i: number, acc: string[]) => {
    if (i === kanji.length) {
      const syls = acc.map(parseSyl); if (syls.some((s) => !s)) return;
      const al = align(ms, syls as Syl[], "on"); if (!al) return;
      if (!best || al.score > best.score) {
        best = { score: al.score, min: Math.min(...al.groupScores), jp: acc.join(" "), romaji: al.groups.map((g) => g.map(moraRomaji).join("")).join("-") };
      }
      return;
    }
    for (const o of options[i]!) walk(i + 1, [...acc, o]);
  };
  walk(0, []);
  return best;
}

/**
 * Below these the kanji's Cantonese reading is a coincidence, not a
 * correspondence: 昨日 zok3 jat6 vs きのう, or 大勢 where 大 is read natively.
 * Mean over the word, and the weakest syllable on its own.
 */
export const ON_THRESHOLD = 0.55, ON_MIN_THRESHOLD = 0.5;
export const isOn = (m: OnMatch | null): m is OnMatch => !!m && m.score >= ON_THRESHOLD && m.min >= ON_MIN_THRESHOLD;

function bankRows(level: string): [string, string][] {
  const csv = readFileSync(new URL(`../data/${level}.csv`, import.meta.url), "utf8");
  return parseCsv(csv).slice(1).filter((r) => r[0] && r[1]).map((r) => [r[0]!, r[1]!]);
}

function classify(d: Dict, level: string): void {
  for (const [expression, reading] of bankRows(level)) {
    const m = onReadingMatch(d, expression, reading);
    console.log([expression, reading, isOn(m) ? "on" : "pun", m ? `${m.score.toFixed(2)}/${m.min.toFixed(2)}` : "", m ? m.jp : "", m ? m.romaji : ""].join("\t"));
  }
}

/** The hint for an on'yomi word is the correspondence itself: 粵音「約束」joek3 cuk1 ≈ yaku-soku */
export function onHint(d: Dict, expression: string, jp: string, romaji: string): string {
  return `粵音「${toTraditional(d, expression.replace(/[～〜]/g, ""))}」${jp} ≈ ${romaji}`;
}

function onHints(d: Dict, level: string): void {
  for (const [expression, reading] of bankRows(level)) {
    const m = onReadingMatch(d, expression, reading);
    if (isOn(m)) console.log([expression, reading, "on", onHint(d, expression, m.jp, m.romaji), m.jp].join("\t"));
  }
}

/**
 * The morae a pun has to cover: the whole reading, less an inflectional ending
 * (る/う/く on a verb, い on an adjective) that the hint need not encode.
 */
export function stemMorae(reading: string): Mora[][] {
  const ms = morae(hintReading(reading));
  const last = ms[ms.length - 1];
  const out = [ms];
  if (ms.length >= 2 && last && /^(る|う|く|ぐ|す|つ|ぬ|ぶ|む|い)$/.test(last.text)) out.push(ms.slice(0, -1));
  return out;
}

/** Every reading of a phrase's characters, toneless, for checking a stored Jyutping. */
function charReadings(d: Dict, phrase: string): string[][] {
  return [...toTraditional(d, phrase)].filter((c) => /[\u3400-\u9fff]/.test(c))
    .map((c) => (d.charJp.get(c) ?? []).map((x) => x.replace(/[1-6]$/, "")));
}

/**
 * Re-check a mnemonics file: the keyword's Jyutping as the dictionary gives it,
 * and how well it covers the stem (pun score, per mora). Prints one line per
 * pun, worst first, so the weakest hints are the first thing on screen.
 */
function verify(d: Dict, path: string): void {
  const rows: { line: string; score: number; note: string }[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const [expression, reading, kind, hint, jyutping = ""] = line.split("\t");
    if (!expression || !reading || !hint || (kind !== "pun" && kind !== "en")) continue;
    const key = hint.match(/【([^】]*)】/)?.[1] ?? "";
    const notes: string[] = [];
    if ([...hint.replace(/[【】]/g, "")].length > 20) notes.push("long");
    let score = -1;
    if (kind === "pun") {
      const jp = phraseJyutping(d, key);
      if (jp.some((x) => x === "?")) notes.push("unknown char");
      // The stored Jyutping must be a reading of each character (tones aside):
      // the word list's reading of 大度 is dok6, but 度 dou6 is what a reader says here.
      const given = jyutping.split(" "), perChar = charReadings(d, key);
      if (given.length !== perChar.length || given.some((g, i) => !perChar[i]!.includes(g.replace(/[1-6]$/, "")))) notes.push(`jyutping≠dict ${jp.join(" ")}`);
      const syls = given.map(parseSyl);
      if (syls.every(Boolean)) {
        for (const stem of stemMorae(reading)) {
          const al = align(stem, syls as Syl[]);
          if (al && al.score > score) score = al.score;
        }
        if (score < 0) notes.push("does not cover the stem");
      }
    }
    rows.push({ line: `${score < 0 ? " -- " : score.toFixed(2)}  ${expression} ${hintReading(reading)}  ${key}  ${jyutping}  ${hint}`, score, note: notes.join("; ") });
  }
  rows.sort((a, b) => a.score - b.score);
  for (const r of rows) console.log(`${r.line}${r.note ? `   <- ${r.note}` : ""}`);
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "fetch") await fetchDicts();
  else if (cmd === "jyutping") { const d = loadDict(); for (const p of rest) console.log(p, phraseJyutping(d, p).join(" ")); }
  else if (cmd === "candidates") { const d = loadDict(); for (const k of rest) candidates(d, k); }
  else if (cmd === "classify") classify(loadDict(), rest[0] ?? "n5");
  else if (cmd === "onhints") onHints(loadDict(), rest[0] ?? "n5");
  else if (cmd === "verify") verify(loadDict(), rest[0] ?? "data/mnemonics.tsv");
  else { console.error("usage: fetch | jyutping <phrase..> | candidates <kana..> | classify [n5|n4] | onhints [n5|n4] | verify [file]"); process.exit(2); }
}

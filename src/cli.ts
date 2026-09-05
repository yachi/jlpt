#!/usr/bin/env bun
/**
 * JLPT study CLI.
 *
 * Two ways to use it:
 *   - Solo:            bun run study
 *   - Driven by Claude: bun run cli next --json  /  bun run cli answer <n> --json
 */
import { openDb, getSetting, setSetting, MODES, type Mode } from "./db";
import { seed } from "./bank";
import {
  nextQuestion, grade, dueCount, humanInterval, scheduler,
  introducedByMode, parseModeWeights, modePriority, hasAudioStimulus, DONT_KNOW,
  introduceCard,
  type Question,
} from "./quiz";
import { speak, synthesize, azureConfigured, readUsage, F0_MONTHLY_CHARS,
  pickVoices, MACOS_JA_VOICES, AZURE_JA_VOICES, type SpeakOptions } from "./tts";
import { importSentences, sentenceCoverage, sentencesEnabled, unheardDrift,
  SENTENCE_SETTING } from "./sentences";

const db = openDb();
const argv = Bun.argv.slice(2);
const cmd = argv[0] ?? "help";
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string, dflt?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const JSON_OUT = flag("json");

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

function levelOpt(): "N5" | "N4" | "both" {
  const l = (opt("level", "both") ?? "both").toLowerCase();
  return l === "n5" ? "N5" : l === "n4" ? "N4" : "both";
}
function modeOpt(): Mode | "any" {
  const m = (opt("mode", "any") ?? "any").toLowerCase();
  return (MODES as readonly string[]).includes(m) ? (m as Mode) : "any";
}

function renderQuestion(q: Question, n?: number): string {
  const head = `${C.dim(`[${q.level} · ${q.mode}${q.isNew ? " · NEW" : ""}]`)}  ${C.bold(q.instruction)}`;
  const furigana = q.promptReading ? `  ${C.dim(`【${q.promptReading}】`)}` : "";
  const body = q.prompt ? `\n\n    ${C.cyan(C.bold(q.prompt))}${furigana}\n` : `\n\n    ${C.dim("(listen)")}\n`;
  const choices = q.choices.length
    ? q.choices.map((c, i) => `    ${i + 1}. ${c}`).join("\n")
    : C.dim("    (type your answer)");
  return `${n !== undefined ? C.dim(`#${n}  `) : ""}${head}${body}\n${choices}\n`;
}

/**
 * Play a question's audio. Returns false only when the learner needed to hear
 * something and did not — a card with no audio stimulus is trivially fine.
 */
async function maybeSpeak(q: Question, voices: SpeakOptions): Promise<boolean> {
  if (!hasAudioStimulus(q)) return true;
  const r = await speak(q.audioText, { rate: "-10%", ...voices });
  return r?.played === true;
}

/** What to print when the question could not be heard. */
function unheardCard(): void {
  console.log(C.red("\n  The audio did not play, so this card cannot be answered."));
  console.log(C.dim("  Answering it now would grade a guess. macOS CoreAudio wedges on sleep/wake;"));
  console.log(C.dim("  log out and back in (or reboot), then run this again.\n"));
}

// ---------------------------------------------------------------- commands

async function cmdSeed() {
  const r = await seed(db);
  const counts = db.query<{ level: string; n: number }, []>(
    "SELECT level, COUNT(*) AS n FROM items GROUP BY level").all();
  console.log(`Seeded ${r.items} items -> ${r.cards} scheduled cards.`);
  if (r.droppedSentences > 0) {
    // Silence here would leave the learner being asked about words that are not
    // in the audio — see the fingerprint comment in bank.ts.
    console.log(C.yellow(
      `  Dropped ${r.droppedSentences} sentence links: the item bank's identity changed, so they\n` +
      "  named different words than the corpus meant. Restore them with: bun run cli import-sentences"));
  }
  const { applied, stale, missing } = r.corrections;
  if (applied > 0) console.log(C.dim(`  Applied ${applied} gloss correction(s) from data/gloss-corrections.csv.`));
  // A correction that no longer matches must be re-read by a human, not
  // silently dropped: either upstream fixed the row (delete the correction) or
  // it changed to something else that still needs checking.
  for (const t of stale) console.log(C.yellow(`  Stale gloss correction — ${t}\n    Re-verify it, then update or delete the row in data/gloss-corrections.csv.`));
  for (const m of missing) console.log(C.yellow(`  Gloss correction names ${m}, which is not in the bank.`));
  for (const c of counts) console.log(`  ${c.level}: ${c.n} words`);
  console.log(C.dim("\nSource: open-anki-jlpt-decks (MIT), derived from tanos.co.uk lists,"));
  console.log(C.dim("which reconstruct the WITHDRAWN 2004 JLPT 出題基準. Unofficial by construction —"));
  console.log(C.dim("JLPT has published no syllabus since 2010."));
}

function pendingSave(q: Question) { setSetting(db, "pending", JSON.stringify(q)); }
function pendingLoad(): Question | null {
  const raw = getSetting(db, "pending", "");
  return raw ? (JSON.parse(raw) as Question) : null;
}

async function cmdNext() {
  const q = nextQuestion(db, { level: levelOpt(), mode: modeOpt() });
  if (!q) {
    const s = dueCount(db);
    // The suggested value must be derived from the current limit, not a constant:
    // a hardcoded hint tells you to *lower* the limit once you have raised it.
    const limit = Number.parseInt(getSetting(db, "new_per_day", "5"), 10);
    // "Come back tomorrow" is wrong whenever a card is due in minutes, which
    // teach-first made the common case: introduceCard() schedules the first
    // test INTRODUCE_DELAY_MS out, so finishing the daily new-card budget
    // leaves a pile of taught-but-untested cards landing shortly.
    const soonest = db.query<{ due: number }, [number]>(
      "SELECT MIN(due) AS due FROM cards WHERE introduced = 1 AND due > ?").get(Date.now())?.due;
    const wait = soonest ? humanInterval(soonest - Date.now()) : null;
    const msg = s.unseen > 0
      ? `Nothing due right now. Daily new-card limit (${limit}) reached`
        + (wait ? ` — next card in ${wait}.` : " — come back tomorrow.")
        + ` Raise the limit with: bun run cli set new_per_day ${limit + 4}`
      : wait
        ? `Nothing due right now; every card introduced. Next card in ${wait}.`
        : "Nothing due and every card introduced. Come back later.";
    if (JSON_OUT) console.log(JSON.stringify({ question: null, reason: msg, ...s }));
    else console.log(C.yellow(msg));
    return;
  }
  pendingSave(q);
  setSetting(db, "pending_shown_at", String(Date.now()));

  const voices = pickVoices();

  if (JSON_OUT) {
    // A teach-first card is not a question, so nothing is withheld: the whole
    // point is to show the learner the answer. Acknowledge it with `cli seen`.
    if (q.teachFirst) {
      const audio = q.audioText
        ? await synthesize(q.audioText, { rate: "-10%", ...voices })
        : null;
      console.log(JSON.stringify({
        teach: {
          itemId: q.itemId, mode: q.mode, level: q.level,
          expression: q.prompt || q.audioText, reveal: q.reveal,
          audioPath: audio?.path, audioVoice: audio?.voice,
          instruction: "New word — study it, then run: cli seen",
        },
        ...dueCount(db),
      }));
      return;
    }
    // answerIndex withheld so an LLM driving this can't see the key.
    const { answerIndex, answer, reveal, ...safe } = q;
    // Synthesize before printing and hand back the path: a conversational
    // driver cannot play what it cannot name, and re-deriving it with a second
    // `tts` call would roll a different voice and a second cache entry.
    const audio = hasAudioStimulus(q)
      ? await synthesize(q.audioText, { rate: "-10%", ...voices })
      : null;
    console.log(JSON.stringify({
      question: { ...safe, audioPath: audio?.path, audioVoice: audio?.voice },
      ...dueCount(db),
    }));
    return;
  }
  if (q.teachFirst) {
    console.log(C.bold(`\n  NEW — ${q.level} · ${q.mode}`));
    console.log(`  ${q.reveal}\n`);
    if (q.audioText) await speak(q.audioText, { rate: "-10%", ...voices });
    const { due } = introduceCard(db, q.itemId, q.mode);
    setSetting(db, "pending", "");
    console.log(C.dim(`  Studied. First test ${humanInterval(due - Date.now())} from now.\n`));
    return;
  }
  console.log(renderQuestion(q));
  if (!await maybeSpeak(q, voices)) unheardCard();
}

/**
 * Acknowledge a taught card, for the --json flow where `next` cannot both show
 * the word and wait for the learner to have read it.
 */
function cmdSeen() {
  const q = pendingLoad();
  if (!q) { console.log(C.yellow("No pending card. Run: bun run cli next")); return; }
  if (!q.teachFirst) {
    console.log(C.red("The pending card is a question, not a new word. Answer it: cli answer <n>"));
    return;
  }
  const { due } = introduceCard(db, q.itemId, q.mode);
  setSetting(db, "pending", "");
  if (JSON_OUT) console.log(JSON.stringify({ introduced: true, itemId: q.itemId, mode: q.mode, firstTestAt: due, ...dueCount(db) }));
  else console.log(C.dim(`  Studied. First test ${humanInterval(due - Date.now())} from now.\n`));
}

async function cmdAnswer() {
  const q = pendingLoad();
  if (!q) { console.log(C.yellow("No pending question. Run: bun run cli next")); return; }
  const response = argv[1];
  if (response === undefined) { console.log(C.red("Usage: cli answer <choice-number|typed-answer|? = don't know>")); return; }

  // Wall-clock is only a valid proxy for thinking time in the interactive TUI.
  // When driven conversationally (--json), the gap between `next` and `answer`
  // includes the whole chat round-trip, which would rate every card Hard.
  // Callers may pass real thinking time with --ms; otherwise assume normal.
  const msFlag = opt("ms");
  const shownAt = Number.parseInt(getSetting(db, "pending_shown_at", "0"), 10);
  const elapsed = msFlag !== undefined
    ? Number.parseInt(msFlag, 10)
    : JSON_OUT ? 0 : shownAt ? Date.now() - shownAt : 0;
  // "?" (or --dont-know) records a miss without inventing an answer.
  const idx = response === DONT_KNOW || flag("dont-know")
    ? DONT_KNOW
    : q.mode === "production" ? response : String(Number(response) - 1);
  const r = grade(db, q, idx, elapsed, { easy: flag("easy") });
  setSetting(db, "pending", "");

  if (JSON_OUT) { console.log(JSON.stringify({ ...r, ...dueCount(db) })); return; }
  console.log(r.correct ? C.green("  ✓ correct") : C.red(`  ✗ wrong — answer: ${r.answer}`));
  console.log(`  ${C.dim(r.reveal)}`);
  console.log(`  ${C.dim(`next in ${r.intervalHuman} · stability ${r.stability?.toFixed(1)}d · rating ${r.rating}`)}\n`);
}

async function cmdStudy() {
  const level = levelOpt(), mode = modeOpt();
  const limit = Number.parseInt(opt("n", "20") ?? "20", 10);
  console.log(C.bold(`\nJLPT study — ${level} · ${mode} · up to ${limit} cards`));
  console.log(C.dim(`TTS: ${azureConfigured()
    ? `Azure neural, ${AZURE_JA_VOICES.length} voices`
    : `macOS voices ${MACOS_JA_VOICES.join("/")} (set AZURE_SPEECH_KEY for neural voices)`}`));
  console.log(C.dim("Answer with 1-4, type kana for production cards, '?' if you don't know,"));
  console.log(C.dim("'r' to replay audio, 'q' to quit.\n"));

  let asked = 0, right = 0;
  while (asked < limit) {
    const q = nextQuestion(db, { level, mode });
    if (!q) { console.log(C.yellow("\nNothing more due right now.")); break; }
    console.log(renderQuestion(q, asked + 1));
    // One speaker per question: the exam plays the same recording twice, so a
    // replay must be the same clip, not a second roll of the dice.
    const voices = pickVoices();
    // Stop rather than skip: if CoreAudio is wedged, every later listening card
    // fails the same way, and a loop that silently drops them looks like
    // progress while teaching nothing.
    if (!await maybeSpeak(q, voices)) { unheardCard(); printSummary(asked, right); return; }

    const t0 = Date.now();
    let response: string | null = null;
    for (;;) {
      const raw = (prompt("  > ") ?? "q").trim();
      if (raw === "q") { console.log(C.dim("\nbye")); printSummary(asked, right); return; }
      if (raw === "r") { await speak(q.audioText ?? q.prompt, { rate: "-10%", ...voices }); continue; }
      response = raw;
      break;
    }
    const idx = response === DONT_KNOW
      ? DONT_KNOW
      : q.mode === "production" ? response! : String(Number(response) - 1);
    const r = grade(db, q, idx, Date.now() - t0);
    asked++; if (r.correct) right++;
    console.log(r.correct ? C.green("  ✓ correct") : C.red(`  ✗ wrong — ${r.answer}`));
    console.log(`  ${C.dim(r.reveal)}   ${C.dim(`next: ${r.intervalHuman}`)}\n`);
    if (!r.correct && q.audioText) await speak(q.audioText, { rate: "-20%", ...voices });
  }
  printSummary(asked, right);
}

function printSummary(asked: number, right: number) {
  if (!asked) return;
  const s = dueCount(db);
  console.log(C.bold(`\n${right}/${asked} correct (${Math.round((right / asked) * 100)}%)`));
  console.log(C.dim(`${s.due} still due · ${s.learned}/${s.total} cards introduced\n`));
}

/**
 * Mock exam mirroring the official JLPT weighting (jlpt.jp):
 *   Language Knowledge + Reading = 0-120, floor 38
 *   Listening                    = 0-60,  floor 19
 *   N4 passes at 90/180, N5 at 80/180 — AND both floors must be cleared.
 * Exam answers do not feed the FSRS scheduler; this is measurement, not practice.
 */
async function cmdExam() {
  const level = (opt("level", "N5") ?? "N5").toUpperCase() as "N5" | "N4";
  const nK = Number.parseInt(opt("knowledge", "20") ?? "20", 10);
  const nL = Number.parseInt(opt("listening", "10") ?? "10", 10);
  const PASS = level === "N4" ? 90 : 80;

  console.log(C.bold(`\nMock ${level} — ${nK} knowledge + ${nL} listening. No feedback until the end.\n`));
  let kRight = 0, lRight = 0;

  /** Returns null when the sitting has to be abandoned rather than scored. */
  const ask = async (mode: Mode, n: number): Promise<number | null> => {
    let right = 0;
    for (let i = 0; i < n; i++) {
      // sentences: false — an exam measures against earlier sittings, so its
      // listening section must not silently switch stimulus mid-history.
      // teachNew: false — an exam measures. Teaching mid-sitting would leak the
      // answer and drop the question from the score.
      const q = nextQuestion(db, { level, mode, newLimit: 0, sentences: false, teachNew: false })
        ?? nextQuestion(db, { level, mode, newLimit: 9999, sentences: false, teachNew: false });
      if (!q) break;
      console.log(renderQuestion(q, i + 1));
      // An exam item nobody could hear must not be scored: it would depress the
      // listening section against every earlier sitting.
      if (!await maybeSpeak(q, pickVoices())) { unheardCard(); return null; }
      const raw = (prompt("  > ") ?? "").trim();
      const idx = q.mode === "production" ? raw : String(Number(raw) - 1);
      // Score only; do not disturb scheduling state.
      const correct = q.mode === "production"
        ? raw.normalize("NFKC").replace(/\s/g, "") === q.answer
        : Number(idx) === q.answerIndex;
      if (correct) right++;
      console.log("");
    }
    return right;
  };

  const k = await ask("meaning", nK);
  const l = k === null ? null : await ask("listening", nL);
  if (k === null || l === null) {
    // Recording a sitting whose listening section was silent would put a
    // fabricated score into the history the next sitting is compared against.
    console.log(C.yellow("  Exam abandoned — nothing recorded."));
    return;
  }
  kRight = k;
  lRight = l;

  const kScore = Math.round((kRight / Math.max(1, nK)) * 120);
  const lScore = Math.round((lRight / Math.max(1, nL)) * 60);
  const total = kScore + lScore;
  const kOk = kScore >= 38, lOk = lScore >= 19, totalOk = total >= PASS;
  const passed = kOk && lOk && totalOk;

  db.query(
    "INSERT INTO exams (level, ts, knowledge_score, knowledge_max, listening_score, listening_max) VALUES (?,?,?,?,?,?)",
  ).run(level, Date.now(), kScore, 120, lScore, 60);

  console.log(C.bold(`\n${level} mock result`));
  console.log(`  Language Knowledge + Reading  ${String(kScore).padStart(3)}/120   floor 38  ${kOk ? C.green("PASS") : C.red("FAIL")}`);
  console.log(`  Listening                     ${String(lScore).padStart(3)}/60    floor 19  ${lOk ? C.green("PASS") : C.red("FAIL")}`);
  console.log(`  Total                         ${String(total).padStart(3)}/180   need ${PASS}  ${totalOk ? C.green("PASS") : C.red("FAIL")}`);
  console.log(`\n  ${passed ? C.green(C.bold("PASS")) : C.red(C.bold("FAIL"))}`);
  if (!passed && totalOk) console.log(C.yellow("  Total cleared but a section floor failed — this is how most N4 candidates fail."));
  console.log(C.dim("\n  Estimates only. Calibrate against the free official workbooks:"));
  console.log(C.dim("  https://www.jlpt.jp/e/samples/sampleindex.html\n"));
}

async function cmdStats() {
  const s = dueCount(db);
  const now = Date.now();
  const rows = db.query<{ mode: string; n: number; correct: number }, []>(
    `SELECT mode, COUNT(*) AS n, SUM(correct) AS correct FROM reviews GROUP BY mode`).all();
  const last7 = db.query<{ n: number; correct: number }, [number]>(
    "SELECT COUNT(*) AS n, COALESCE(SUM(correct),0) AS correct FROM reviews WHERE ts > ?",
  ).get(now - 7 * 86_400_000)!;
  const mature = db.query<{ n: number }, []>(
    "SELECT COUNT(*) AS n FROM cards WHERE introduced = 1 AND stability >= 21").get()!.n;
  const usage = await readUsage();

  if (JSON_OUT) {
    console.log(JSON.stringify({ ...s, mature, byMode: rows, last7, ttsUsage: usage }, null, 2));
    return;
  }
  console.log(C.bold("\nProgress"));
  console.log(`  introduced   ${s.learned}/${s.total} cards   (${s.unseen} unseen)`);
  console.log(`  due now      ${s.due}`);
  console.log(`  mature       ${mature}  ${C.dim("(stability >= 21d)")}`);
  console.log(`  last 7 days  ${last7.n} reviews, ${last7.n ? Math.round((last7.correct / last7.n) * 100) : 0}% correct`);
  if (rows.length) {
    console.log(C.bold("\nBy mode"));
    for (const r of rows) {
      const pct = r.n ? Math.round((r.correct / r.n) * 100) : 0;
      const warn = r.mode === "listening" && pct < 60 ? C.red("  <- weakest section is the usual N4 failure") : "";
      console.log(`  ${r.mode.padEnd(11)} ${String(r.n).padStart(5)} reviews  ${String(pct).padStart(3)}%${warn}`);
    }
  }
  const counts = introducedByMode(db);
  const weights = parseModeWeights(getSetting(db, "mode_weights", ""));
  const introTotal = Object.values(counts).reduce((a, b) => a + b, 0);
  const wSum = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
  if (introTotal) {
    console.log(C.bold("\nNew-card mix vs target"));
    for (const m of modePriority(counts, weights)) {
      const actual = (counts[m] / introTotal) * 100;
      const target = (weights[m] / wSum) * 100;
      const gap = actual - target;
      const flag = gap < -10 ? C.yellow(" <- next up") : "";
      console.log(`  ${m.padEnd(11)} ${counts[m].toString().padStart(4)} cards  ${actual.toFixed(0).padStart(3)}% vs ${target.toFixed(0).padStart(3)}% target${flag}`);
    }
  }

  const cov = sentenceCoverage(db);
  if (cov.listening) {
    console.log(C.bold("\nSentence listening"));
    const pct = Math.round((cov.withSentence / cov.listening) * 100);
    console.log(`  ${sentencesEnabled(db) ? C.green("on ") : C.dim("off")}          ${cov.withSentence}/${cov.listening} listening cards have a sentence (${pct}%), ${cov.distinct} distinct`);
    const byStim = db.query<{ kind: string; n: number; hard: number }, []>(
      `SELECT CASE WHEN sentence_id IS NULL THEN 'word' ELSE 'sentence' END AS kind,
              COUNT(*) AS n, SUM(rating = 2) AS hard
         FROM reviews WHERE mode = 'listening' GROUP BY kind`).all();
    // The open risk is that sentence reviews are systematically rated Hard,
    // which shortens intervals and floods the queue. This is the measurement.
    for (const b of byStim) {
      console.log(`  ${b.kind.padEnd(11)} ${String(b.n).padStart(5)} reviews  ${b.n ? Math.round((b.hard / b.n) * 100) : 0}% rated Hard`);
    }
  }

  const exams = db.query<any, []>("SELECT * FROM exams ORDER BY ts DESC LIMIT 5").all();
  if (exams.length) {
    console.log(C.bold("\nRecent mock exams"));
    for (const e of exams) {
      const d = new Date(e.ts).toISOString().slice(0, 10);
      console.log(`  ${d}  ${e.level}  K ${String(e.knowledge_score).padStart(3)}/120  L ${String(e.listening_score).padStart(2)}/60  total ${e.knowledge_score + e.listening_score}/180`);
    }
  }
  console.log(C.bold("\nTTS"));
  console.log(`  provider     ${azureConfigured()
    ? `Azure neural (${AZURE_JA_VOICES.length} ja-JP voices)`
    : `macOS say (${MACOS_JA_VOICES.length} ja_JP voices)`}`);
  console.log(`  free tier    ${usage.chars.toLocaleString()}/${F0_MONTHLY_CHARS.toLocaleString()} chars used this month (${((usage.chars / F0_MONTHLY_CHARS) * 100).toFixed(2)}%)`);
  console.log("");
}

async function cmdTts() {
  const text = argv.slice(1).filter((a) => !a.startsWith("--")).join(" ") || "こんにちは。日本語の勉強を始めましょう。";
  // A fresh speaker each time, unless pinned: replaying one voice trains
  // waveform recall, and the exam does not use one voice.
  const pinned = opt("voice", "");
  const voices = pinned ? { voice: pinned, macVoice: pinned } : pickVoices();
  const r = await speak(text, { rate: opt("rate", "0%"), ...voices });
  if (!r) { console.log(C.red("TTS unavailable.")); return; }
  console.log(`${C.dim(`[${r.provider}:${r.voice}]`)} ${text}\n${C.dim(r.path)}`);
}

/**
 * Load data/sentences.json into the database. Replaces, then recomputes
 * n_unheard from the current cards — so this is also the repair path if the
 * incremental counter ever drifts.
 */
async function cmdImportSentences() {
  if (flag("check")) {
    const drift = unheardDrift(db);
    const cov = sentenceCoverage(db);
    if (JSON_OUT) { console.log(JSON.stringify({ drift, ...cov })); return; }
    console.log(drift.length === 0
      ? C.green(`  n_unheard agrees with the cards table for all ${db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sentences").get()!.n} sentences.`)
      : C.red(`  ${drift.length} sentences drifted — re-run without --check to repair.`));
    for (const d of drift.slice(0, 10)) console.log(`    ${d.id}: stored ${d.stored}, actual ${d.actual}`);
    console.log(C.dim(`  ${cov.withSentence}/${cov.listening} introduced listening cards have a sentence (${cov.distinct} distinct).`));
    return;
  }
  const r = await importSentences(db);
  const cov = sentenceCoverage(db);
  console.log(`Imported ${r.sentences} sentences, ${r.links} word links${r.blacklisted ? `, ${r.blacklisted} blacklisted` : ""}.`);
  console.log(`  ${cov.withSentence}/${cov.listening} introduced listening cards have an eligible sentence (${cov.distinct} distinct).`);
  if (!sentencesEnabled(db)) {
    console.log(C.yellow(`  Sentence stimuli are OFF. Enable with: bun run cli set ${SENTENCE_SETTING} 1`));
  }
  console.log(C.dim("\n  Tatoeba, CC BY 2.0 FR — contributors are named in data/CREDITS.md."));
  console.log(C.dim("  Drop a bad sentence by putting its id in data/sentence-blacklist.txt."));
}

function cmdSet() {
  const [, k, v] = argv;
  if (!k || v === undefined) { console.log("Usage: cli set <key> <value>   (e.g. new_per_day 8)"); return; }
  setSetting(db, k, v);
  console.log(`${k} = ${v}`);
}

function cmdHelp() {
  console.log(`
${C.bold("JLPT study CLI")}

  ${C.cyan("bun run seed")}                     load the N5/N4 item bank (run once)
  ${C.cyan("bun run study")} [--level n5|n4] [--mode meaning|reading|listening|production] [--n 20]
  ${C.cyan("bun run cli next")} [--json]        show the next due card
  ${C.cyan("bun run cli answer <n>")} [--json]  answer the pending card (1-4, typed kana, or ? = don't know)
  ${C.cyan("bun run cli seen")} [--json]        acknowledge a NEW word that was taught rather than asked
  ${C.cyan("bun run cli exam")} --level n5      mock exam scored against the real sectional floors
  ${C.cyan("bun run cli stats")} [--json]       progress, weakest mode, TTS quota used
  ${C.cyan("bun run cli tts")} <text>           speak Japanese (Azure neural, or macOS fallback)
  ${C.cyan("bun run cli set")} new_per_day 8    change the daily new-card limit (default 5)
  ${C.cyan("bun run cli import-sentences")}     load data/sentences.json (add --check to verify, not write)
  ${C.cyan("bun run cli set")} ${SENTENCE_SETTING} 1
                                    play a full sentence on listening cards whose
                                    other words are all already known by ear

${C.dim("Azure neural voices are optional. Without a key it rotates the installed macOS ja_JP voices.")}
${C.dim("  export AZURE_SPEECH_KEY=...   export AZURE_SPEECH_REGION=japaneast")}
`);
}

switch (cmd) {
  case "seed": await cmdSeed(); break;
  case "next": await cmdNext(); break;
  case "answer": await cmdAnswer(); break;
  case "seen": cmdSeen(); break;
  case "study": await cmdStudy(); break;
  case "exam": await cmdExam(); break;
  case "stats": await cmdStats(); break;
  case "tts": await cmdTts(); break;
  case "set": cmdSet(); break;
  case "import-sentences": await cmdImportSentences(); break;
  default: cmdHelp();
}
db.close();

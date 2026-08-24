import type { Database } from "bun:sqlite";
import { Scheduler, newCard, type Card, type Rating } from "./fsrs";
import { distractors, shortMeaning, productionPrompt, type Item } from "./bank";
import { MODES, MODE_SECTION, getSetting, type Mode } from "./db";
import { readingKey } from "./romaji";
import { pickSentence, sentencesEnabled, decrementUnheardFor, type SentenceStimulus } from "./sentences";

export const scheduler = new Scheduler();

/** How long to wait before introducing another mode of the same word. */
export const SIBLING_COOLDOWN_MS = 20 * 60 * 60 * 1000; // 20h — i.e. "not the same day"

/** Default target share of introduced cards per mode. Equal split. */
export const DEFAULT_MODE_WEIGHTS: Record<Mode, number> = {
  meaning: 25, reading: 25, listening: 25, production: 25,
};

/** Parse "listening:50,reading:25,production:15,meaning:10". Unknown keys ignored. */
export function parseModeWeights(spec: string): Record<Mode, number> {
  const out = { ...DEFAULT_MODE_WEIGHTS };
  if (!spec.trim()) return out;
  const parsed: Partial<Record<Mode, number>> = {};
  for (const part of spec.split(",")) {
    const [k, v] = part.split(":").map((s) => s.trim());
    const n = Number(v);
    if (k && (MODES as readonly string[]).includes(k) && Number.isFinite(n) && n >= 0) {
      parsed[k as Mode] = n;
    }
  }
  if (Object.keys(parsed).length === 0) return out;
  // Unspecified modes get 0 — an explicit spec is a complete statement of intent.
  for (const m of MODES) out[m] = parsed[m] ?? 0;
  if (MODES.every((m) => out[m] === 0)) return { ...DEFAULT_MODE_WEIGHTS };
  return out;
}

/**
 * Order modes by how far each is BELOW its target share of introduced cards.
 * Deterministic, and self-correcting: a mode that has fallen behind is picked
 * first until it catches up, so changing the weights repairs an existing
 * imbalance instead of only affecting cards from here on.
 */
export function modePriority(
  counts: Record<Mode, number>, weights: Record<Mode, number>,
): Mode[] {
  const total = MODES.reduce((a, m) => a + counts[m], 0);
  const weightSum = MODES.reduce((a, m) => a + weights[m], 0) || 1;
  return [...MODES].sort((a, b) => {
    const deficit = (m: Mode) => (weights[m] / weightSum) * (total + 1) - counts[m];
    const d = deficit(b) - deficit(a);
    return d !== 0 ? d : MODES.indexOf(a) - MODES.indexOf(b); // stable tiebreak
  });
}

export function introducedByMode(db: Database): Record<Mode, number> {
  // Annotated, NOT `as` — the cast would let a newly added mode compile with an
  // undefined count, and modePriority sums these: one undefined turns `total`
  // into NaN, every deficit into NaN, and the sort silently collapses to
  // declaration order. A missing key must be a compile error.
  const counts: Record<Mode, number> = { meaning: 0, reading: 0, listening: 0, production: 0 };
  for (const r of db.query<{ mode: Mode; n: number }, []>(
    "SELECT mode, COUNT(*) AS n FROM cards WHERE introduced = 1 GROUP BY mode").all()) {
    counts[r.mode] = r.n;
  }
  return counts;
}

export interface Question {
  itemId: number;
  mode: Mode;
  level: string;
  /** Human-readable instruction. */
  instruction: string;
  /** Text shown on screen. Empty for listening (audio only). */
  prompt: string;
  /**
   * Kana reading shown alongside the prompt. Set ONLY for `meaning` cards —
   * on `reading` it is the answer, and on `production` it is what you must type.
   */
  promptReading?: string;
  /** Japanese to synthesize, if this question has audio. */
  audioText?: string;
  /**
   * Whether that audio IS the question, rather than a reveal aid.
   *
   * `meaning` cards also carry audioText — to play the word back *after*
   * answering — so audio-bearing and audio-is-the-stimulus are two different
   * properties. Playing a meaning card's audio up front would just narrate a
   * word already on screen; playing a listening card's is the whole card.
   */
  audioIsStimulus?: boolean;
  /**
   * Tatoeba id of the sentence played instead of the bare word, when one was
   * eligible. Present only on `listening`; absent means the word was played.
   */
  sentenceId?: number;
  /** MC options; empty for typed production. */
  choices: string[];
  answerIndex: number;
  /** Correct answer as text (for typed grading + feedback). */
  answer: string;
  /**
   * Other readings that are equally correct, when the prompt genuinely cannot
   * single one out — あした and あす are both "tomorrow". Empty for every card
   * whose prompt is unambiguous.
   */
  alsoAccept?: string[];
  /** Shown after answering. */
  reveal: string;
  isNew: boolean;
  section: "knowledge" | "listening";
}

interface CardRow {
  item_id: number; mode: Mode; stability: number | null; difficulty: number | null;
  state: string; step: number | null; due: number; last_review: number | null; introduced: number;
}

function toCard(r: CardRow): Card {
  return {
    stability: r.stability, difficulty: r.difficulty,
    state: r.state as Card["state"], step: r.step,
    due: r.due, lastReview: r.last_review,
  };
}

export function dueCount(db: Database, now = Date.now()) {
  const due = db.query<{ n: number }, [number]>(
    "SELECT COUNT(*) AS n FROM cards WHERE introduced = 1 AND due <= ?").get(now)!.n;
  const learned = db.query<{ n: number }, []>(
    "SELECT COUNT(*) AS n FROM cards WHERE introduced = 1").get()!.n;
  const total = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM cards").get()!.n;
  return { due, learned, total, unseen: total - learned };
}

function newIntroducedToday(db: Database, now = Date.now()): number {
  const startOfDay = new Date(now).setHours(0, 0, 0, 0);
  return db.query<{ n: number }, [number]>(
    `SELECT COUNT(DISTINCT item_id || ':' || mode) AS n FROM reviews
     WHERE ts >= ? AND id IN (SELECT MIN(id) FROM reviews GROUP BY item_id, mode)`,
  ).get(startOfDay)!.n;
}

export interface NextOptions {
  level?: "N5" | "N4" | "both";
  mode?: Mode | "any";
  now?: number;
  rng?: () => number;
  /** Override the configured daily new-card limit. */
  newLimit?: number;
  /**
   * Allow a sentence stimulus on listening cards. Defaults to the
   * `sentence_listening` setting. The mock exam passes `false` explicitly:
   * exam items flow through this same path, so without an opt-out its listening
   * section would silently become sentence listening and the score would stop
   * being comparable with earlier sittings.
   */
  sentences?: boolean;
}

/**
 * Pick the next card: most-overdue review first, otherwise introduce a new card
 * if under today's new limit. Returns null when nothing is due.
 */
export function nextQuestion(db: Database, opts: NextOptions = {}): Question | null {
  const now = opts.now ?? Date.now();
  const rng = opts.rng ?? Math.random;
  const level = opts.level ?? "both";
  const mode = opts.mode ?? "any";
  const newLimit = opts.newLimit ?? Number.parseInt(getSetting(db, "new_per_day", "5"), 10);

  const levelSql = level === "both" ? "" : " AND i.level = ?";
  const modeSql = mode === "any" ? "" : " AND c.mode = ?";
  const params: (string | number)[] = [];
  if (level !== "both") params.push(level);
  if (mode !== "any") params.push(mode);

  let row = db.query<CardRow & Item, any[]>(
    `SELECT c.*, i.level, i.expression, i.reading, i.meaning, i.has_kanji
       FROM cards c JOIN items i ON i.id = c.item_id
      WHERE c.introduced = 1 AND c.due <= ?${levelSql}${modeSql}
      ORDER BY c.due ASC LIMIT 1`,
  ).get(now, ...params) as (CardRow & Item) | null;

  let isNew = false;
  if (!row && newIntroducedToday(db, now) < newLimit) {
    isNew = true;
    // Introduce easiest-first: N5 before N4, and within a level, in list order.
    // Don't introduce a second mode of a word you just saw: answering 「ああ」as
    // listening 30s after seeing it as text tests short-term memory, not the word.
    // Siblings are deprioritised (not banned) until SIBLING_COOLDOWN_MS has passed.
    const cutoff = now - SIBLING_COOLDOWN_MS;
    // For a learner with a kanji background, "what does 秋 mean?" is a free point.
    // When enabled, kanji words skip `meaning` and go straight to reading /
    // listening / production — except Sino-Japanese false friends, where the
    // kanji background actively misleads and the meaning card earns its place.
    // Mode is now chosen by deficit against the target mix, so a mode that has
    // fallen behind (typically listening) is introduced first until it catches up.
    const priority = modePriority(introducedByMode(db), parseModeWeights(getSetting(db, "mode_weights", "")));
    const modeRank = `CASE c.mode ${priority.map((m, i) => `WHEN '${m}' THEN ${i}`).join(" ")} ELSE 99 END`;

    const skipKanjiMeaning = getSetting(db, "skip_meaning_for_kanji", "0") === "1"
      ? ` AND NOT (c.mode = 'meaning' AND i.has_kanji = 1
                   AND i.expression NOT IN (SELECT expression FROM false_friends))`
      : "";
    row = db.query<CardRow & Item, any[]>(
      `SELECT c.*, i.level, i.expression, i.reading, i.meaning, i.has_kanji
         FROM cards c JOIN items i ON i.id = c.item_id
        WHERE c.introduced = 0${levelSql}${modeSql}${skipKanjiMeaning}
        ORDER BY ${modeRank} ASC,
                 COALESCE((SELECT MAX(r.ts) FROM reviews r WHERE r.item_id = c.item_id), 0) > ? ASC,
                 CASE i.level WHEN 'N5' THEN 0 ELSE 1 END, c.item_id ASC
        LIMIT 1`,
      // NOTE: positional `?` bind in SQL text order — the WHERE params come
      // before the ORDER BY cutoff, so `cutoff` must go LAST.
    ).get(...params, cutoff) as (CardRow & Item) | null;
  }
  if (!row) return null;

  const item: Item = {
    id: row.item_id, level: row.level, expression: row.expression,
    reading: row.reading, meaning: row.meaning, has_kanji: row.has_kanji,
  };

  let sentence: SentenceStimulus | null = null;
  if (row.mode === "listening" && (opts.sentences ?? sentencesEnabled(db))) {
    // Whether the TARGET is already known by ear decides which counter value
    // makes a sentence i+1 for it — see pickSentence().
    const targetKnown = row.introduced === 1 && row.state !== "learning";
    sentence = pickSentence(db, row.item_id, targetKnown, rng);
  }
  return buildQuestion(db, item, row.mode, isNew, rng, sentence);
}

function shuffleWithAnswer(answer: string, wrong: string[], rng: () => number) {
  const all = [answer, ...wrong];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [all[i], all[j]] = [all[j]!, all[i]!];
  }
  return { choices: all, answerIndex: all.indexOf(answer) };
}

export function buildQuestion(
  db: Database, item: Item, mode: Mode, isNew: boolean, rng: () => number = Math.random,
  sentence: SentenceStimulus | null = null,
): Question {
  const meaning = shortMeaning(item.meaning);
  const base = {
    itemId: item.id, mode, level: item.level, isNew,
    section: MODE_SECTION[mode],
    // Keep the expression【reading】head first: checkAnswer parses the written
    // forms back out of it for typed grading.
    reveal: `${item.expression}【${item.reading}】— ${item.meaning}`,
  };

  switch (mode) {
    case "meaning": {
      const { choices, answerIndex } = shuffleWithAnswer(meaning, distractors(db, item, "meaning", 3, rng), rng);
      return { ...base, instruction: "What does this mean?", prompt: item.expression,
        // Safe here: this card tests meaning, so the reading is a hint, not the answer.
        promptReading: item.reading === item.expression ? undefined : item.reading,
        audioText: item.expression, choices, answerIndex, answer: meaning };
    }
    case "reading": {
      const { choices, answerIndex } = shuffleWithAnswer(item.reading, distractors(db, item, "reading", 3, rng), rng);
      return { ...base, instruction: "How is this read? (漢字読み)", prompt: item.expression,
        choices, answerIndex, answer: item.reading };
    }
    case "listening": {
      if (sentence) {
        // Every OTHER word in the sentence is known by ear, so the learner
        // heard several things they can name. Barring their glosses is what
        // makes exactly one choice correct — otherwise perfect comprehension
        // can pick a distractor and grade as Again.
        const heard = sentence.itemIds.length
          ? db.query<{ meaning: string }, []>(
              `SELECT meaning FROM items WHERE id IN (${sentence.itemIds.join(",")})`)
            .all().map((r) => shortMeaning(r.meaning))
          : [];
        const { choices, answerIndex } = shuffleWithAnswer(
          meaning, distractors(db, item, "meaning", 3, rng, heard), rng);
        return { ...base, instruction: "Which of these did you hear? (聴解)", prompt: "",
          audioText: sentence.ja, audioIsStimulus: true, sentenceId: sentence.id,
          reveal: `${base.reveal}\n    ${sentence.ja}\n    ${sentence.en}`,
          choices, answerIndex, answer: meaning };
      }
      const { choices, answerIndex } = shuffleWithAnswer(meaning, distractors(db, item, "meaning", 3, rng), rng);
      return { ...base, instruction: "Listen, then choose the meaning. (聴解)", prompt: "",
        audioText: speakableReading(item.reading), audioIsStimulus: true,
        choices, answerIndex, answer: meaning };
    }
    case "production": {
      // NOT `meaning`: a short gloss does not determine a reading — see
      // productionPrompt() for the 11.6% of cards that made unanswerable.
      const { prompt, alsoAccept } = productionPrompt(db, item);
      return { ...base, instruction: "Type the Japanese reading (kana).", prompt,
        choices: [], answerIndex: -1, answer: item.reading,
        ...(alsoAccept.length ? { alsoAccept } : {}) };
    }
  }
}

/**
 * The kana to synthesize for a listening card.
 *
 * NOT the written form. Bank entries are written-form keyed, and nine of them
 * share a kanji with a different word: 開く is both あく and ひらく, 空く is
 * both あく and すく, 明日 is both あした and あす. Synthesizing the kanji
 * makes the TTS pick one, so BOTH cards play the same audio while expecting
 * different answers -- verified against Azure with pronunciation assessment:
 * 開く reads ひらく (98 vs 60), 空く reads あく (95 vs 55), 止める reads
 * とめる (94 vs 70). The reading is unambiguous, and synthesizing it was
 * verified to produce exactly itself for all eight testable pairs.
 *
 * Readings also carry list notation ("いい; よい"), okurigana placeholders
 * ("お～") and parenthetical suffixes ("けっこん (する)"); take the first
 * listed form and drop the annotations, since only one can be spoken.
 */
export function speakableReading(reading: string): string {
  const first = reading.split(/[;；/／]/)[0] ?? reading;
  return first
    .replace(/[（(][^）)]*[）)]/g, "")   // "(する)", "(〜を)"
    .replace(/[～〜~]/g, "")
    .trim();
}

/**
 * Whether the audio must be played for the question to be answerable.
 *
 * Ask the question, not its mode. Three call sites used to test
 * `q.mode === "listening"` instead, so any future audio-bearing mode had to
 * remember to update all three — and one of them had already drifted.
 */
export function hasAudioStimulus(q: Question): q is Question & { audioText: string } {
  return q.audioIsStimulus === true && typeof q.audioText === "string" && q.audioText !== "";
}

/** Normalize typed input: NFKC, strip whitespace and the ~ placeholder used in the lists. */
export function normalize(s: string): string {
  return s.normalize("NFKC").replace(/[\s　～~]/g, "").toLowerCase();
}

/**
 * Bank entries list alternative writings in one field ("足; 脚"), so a typed
 * answer has to be matched against each form, not against the joined string.
 */
const FORM_SEPARATOR = /[;；/／、,，]/;

export function checkAnswer(q: Question, response: string | number): boolean {
  if (q.mode !== "production") return Number(response) === q.answerIndex;

  const given = normalize(String(response));
  if (given === "") return false;
  const givenKey = readingKey(given);

  // Accept the kana reading or any written form — an IME user may type either,
  // and readingKey() additionally accepts romaji for anyone without an IME.
  const expression = q.reveal.match(/^(.+?)【/)?.[1] ?? "";
  const forms = [
    ...q.answer.split(FORM_SEPARATOR),
    ...expression.split(FORM_SEPARATOR),
    // A prompt naming a synonym set has more than one right answer; grading
    // only the item we happened to schedule would fail a correct learner.
    ...(q.alsoAccept ?? []).flatMap((r) => r.split(FORM_SEPARATOR)),
  ].map(normalize).filter((f) => f !== "");

  return forms.some((f) => f === given || readingKey(f) === givenKey);
}

/** Thinking budget for a card whose stimulus is text already on screen. */
export const SLOW_MS = 12_000;

/**
 * Rough milliseconds of speech per Japanese character, at the -10% rate the
 * study loop uses. Doubled below to allow one replay, which the TUI's `r` and
 * a conversational driver's second play both charge to the same clock.
 */
const MS_PER_CHAR = 180;

/**
 * The "too slow" threshold for one question.
 *
 * A fixed 12s meant that listening to a 25-character sentence and answering
 * correctly was rated Hard purely for the length of the audio — the stimulus
 * has to be heard before the thinking can start. Applies to word audio too,
 * for the same reason and to a much smaller degree.
 *
 * Calibration is checkable after rollout: reviews.sentence_id records which
 * stimulus was played, so the Hard rate can be compared between the two.
 */
export function slowThresholdFor(q: Question): number {
  if (!hasAudioStimulus(q)) return SLOW_MS;
  return SLOW_MS + q.audioText.length * MS_PER_CHAR * 2;
}

/**
 * Map a graded response onto an FSRS rating.
 *   wrong                 -> 1 Again
 *   right but slow        -> 2 Hard
 *   right                 -> 3 Good
 * Rating 4 (Easy) is reserved for an explicit user override, so that ordinary
 * correct answers don't inflate intervals.
 */
export function ratingFor(
  correct: boolean, elapsedMs: number, easyOverride = false, slowMs = SLOW_MS,
): Rating {
  if (!correct) return 1;
  if (easyOverride) return 4;
  return elapsedMs > slowMs ? 2 : 3;
}

export interface GradeResult {
  correct: boolean; rating: Rating; answer: string; reveal: string;
  nextDue: number; intervalHuman: string; stability: number | null; retrievability: number;
}

export function grade(
  db: Database, q: Question, response: string | number, elapsedMs = 0,
  opts: { now?: number; easy?: boolean; rng?: () => number } = {},
): GradeResult {
  const now = opts.now ?? Date.now();
  const correct = checkAnswer(q, response);
  const rating = ratingFor(correct, elapsedMs, opts.easy, slowThresholdFor(q));

  const row = db.query<CardRow, [number, string]>(
    "SELECT * FROM cards WHERE item_id = ? AND mode = ?").get(q.itemId, q.mode);
  const before: Card = row && row.introduced === 1 ? toCard(row) : newCard(now);
  const after = scheduler.review(before, rating, now, opts.rng ?? Math.random);

  // One transaction. sentences.n_unheard is a monotone counter maintained by
  // the third statement; if it were to miss while the card update landed, the
  // drift would be permanent and silent — the sentence would simply stop being
  // offered, and nothing would ever report it.
  let cardWritten = 0;
  db.transaction(() => {
    cardWritten = db.query(
      `UPDATE cards SET stability=?, difficulty=?, state=?, step=?, due=?, last_review=?, introduced=1
        WHERE item_id=? AND mode=?`,
    ).run(after.stability, after.difficulty, after.state, after.step, after.due, after.lastReview, q.itemId, q.mode).changes;

    db.query(
      "INSERT INTO reviews (item_id, mode, rating, correct, ts, elapsed_ms, sentence_id) VALUES (?,?,?,?,?,?,?)",
    ).run(q.itemId, q.mode, rating, correct ? 1 : 0, now, elapsedMs, q.sentenceId ?? null);

    // GRADUATION, not introduction. `introduced` is set on the first review,
    // while the card is still walking the learning steps — hooking there would
    // admit the words the learner knows LEAST well first. Monotone: a lapse
    // goes review -> relearning, never back to learning (fsrs.ts:221-223).
    //
    // `cardWritten` is not belt-and-braces. When the cards row does not exist
    // the UPDATE matches nothing, but `before` falls back to newCard() —
    // state 'learning' — so the predicate fires and the counter falls for a
    // word that never became known by ear. Measured on a deleted row: 46
    // sentences decremented, 0 card rows written, 46 sentences permanently
    // adrift. A question can outlive its card: `pending` is stored as JSON in
    // settings and answered later, and items cascade-delete their cards.
    if (cardWritten > 0
        && q.mode === "listening" && before.state === "learning" && after.state === "review") {
      decrementUnheardFor(db, q.itemId);
    }
  })();

  return {
    correct, rating, answer: q.answer, reveal: q.reveal,
    nextDue: after.due, intervalHuman: humanInterval(after.due - now),
    stability: after.stability, retrievability: scheduler.retrievability(after, now),
  };
}

export function humanInterval(ms: number): string {
  const m = ms / 60_000;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)}d`;
  if (d < 365) return `${(d / 30.4).toFixed(1)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}

export { MODES };

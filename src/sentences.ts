/**
 * Sentence stimuli for listening cards.
 *
 * This is NOT a fifth mode. A `listening` card normally plays one word; when a
 * sentence exists in which every OTHER content word is already known BY EAR,
 * the card plays that sentence instead and asks the same question. Same card,
 * same FSRS state, same grading.
 *
 * Why 100% coverage of the context: a listening question is only a valid
 * measurement of the target word if failure is attributable to the target,
 * not to vocabulary the learner never studied. van Zeeland & Schmitt (2013),
 * Applied Linguistics 34(4) 457-479, put the coverage threshold for adequate
 * listening comprehension near 95%; this sits above it deliberately.
 *
 * The corpus is built offline by tools/build_sentences.py and checked in, so
 * nothing here re-derives the mapping. src/sentences.test.ts is what guards it
 * from drifting against the bank.
 */
import type { Db } from "./sqlite";
import { getSetting, setSetting } from "./schema";
import { readDataFile, readPath } from "./data-files";
import { bankFingerprint, BANK_FINGERPRINT_KEY } from "./bank";

/** Off by default: the corpus only covers ~half of listening cards by day 30. */
export const SENTENCE_SETTING = "sentence_listening";

export function sentencesEnabled(db: Db): boolean {
  return getSetting(db, SENTENCE_SETTING, "0") === "1";
}

/**
 * Known BY EAR, not merely introduced.
 *
 * `introduced` is set on the FIRST review, while the card is still walking the
 * learning steps [1m, 10m] -- so a word the learner keeps failing would count
 * as known, admitting the words known LEAST well first. Graduation out of
 * initial learning is the event that means "parsed it without the text".
 *
 * `relearning` counts as known: the word was parseable once, and excluding
 * lapsed words would churn hundreds of counter rows on every lapse of a common
 * word. It also keeps the counter monotone -- see decrementUnheardFor().
 */
export const KNOWN_BY_EAR_SQL =
  "mode = 'listening' AND introduced = 1 AND state <> 'learning'";

export interface SentenceStimulus {
  id: number;
  ja: string;
  en: string;
  /** Every bank item in the sentence, target included. Used to bar distractors. */
  itemIds: number[];
}

/**
 * How many of the shortest eligible sentences to rotate between.
 *
 * One canonical sentence per word would train recall of a single clip; an
 * unbounded pool would synthesize a new clip on every review, against a
 * 0.5M char/month quota that also multiplies by the 8 rotating voices.
 */
export const ROTATION = 5;

/**
 * Pick a sentence to play for `itemId`, or null to fall back to the word.
 *
 * Eligibility without a correlated subquery, using the materialised counter:
 *   target known by ear   -> n_unheard = 0
 *   target NOT known      -> n_unheard = 1
 * The second holds because the target is itself in the sentence and is itself
 * unheard, so a total of one unheard word entails that word IS the target.
 */
export function pickSentence(
  db: Db, itemId: number, targetKnown: boolean, rng: () => number = Math.random,
): SentenceStimulus | null {
  const rows = db.query<{ id: number; ja: string; en: string }, [number, number, number]>(
    `SELECT s.id, s.ja, s.en
       FROM sentence_items si JOIN sentences s ON s.id = si.sentence_id
      WHERE si.item_id = ? AND si.ambiguous = 0 AND s.n_unheard = ?
      ORDER BY s.n_items ASC, s.id ASC
      LIMIT ?`,
  ).all(itemId, targetKnown ? 0 : 1, ROTATION);
  const chosen = rows[Math.floor(rng() * rows.length)];
  if (!chosen) return null;
  const itemIds = db.query<{ item_id: number }, [number]>(
    "SELECT item_id FROM sentence_items WHERE sentence_id = ?").all(chosen.id).map((r) => r.item_id);
  return { ...chosen, itemIds };
}

/**
 * Record that `itemId` just became known by ear.
 *
 * Called from grade() inside the same transaction as the card update. A missed
 * decrement on a monotone counter is permanent, silent drift -- the sentence
 * simply stops being offered and nothing ever reports it. Returns the number of
 * sentences touched so callers can assert on it.
 */
export function decrementUnheardFor(db: Db, itemId: number): number {
  return db.query(
    `UPDATE sentences SET n_unheard = n_unheard - 1
      WHERE n_unheard > 0
        AND id IN (SELECT sentence_id FROM sentence_items WHERE item_id = ?)`,
  ).run(itemId).changes;
}

/**
 * Rebuild n_unheard from the current cards state. Idempotent, and the repair
 * path if a decrement is ever missed.
 */
export function recomputeUnheard(db: Db): void {
  db.exec(`
    UPDATE sentences SET n_unheard = (
      SELECT COUNT(*) FROM sentence_items si
       WHERE si.sentence_id = sentences.id
         AND NOT EXISTS (SELECT 1 FROM cards c
                          WHERE c.item_id = si.item_id AND ${KNOWN_BY_EAR_SQL}))`);
}

/** Sentences whose stored n_unheard disagrees with the cards table. */
export function unheardDrift(db: Db): { id: number; stored: number; actual: number }[] {
  return db.query<{ id: number; stored: number; actual: number }, []>(`
    SELECT s.id, s.n_unheard AS stored,
           (SELECT COUNT(*) FROM sentence_items si
             WHERE si.sentence_id = s.id
               AND NOT EXISTS (SELECT 1 FROM cards c
                                WHERE c.item_id = si.item_id AND ${KNOWN_BY_EAR_SQL})) AS actual
      FROM sentences s`).all().filter((r) => r.stored !== r.actual);
}

export interface CorpusSentence {
  id: number; ja: string; en: string; author: string | null;
  items: number[]; ambiguous: number[];
}

export interface ImportResult {
  sentences: number; links: number; blacklisted: number;
}

/**
 * Load data/sentences.json into the database, replacing whatever was there.
 *
 * Replace rather than merge: every column here is derived from the corpus file
 * and the cards table, so there is no state to preserve, and a merge would let
 * a sentence dropped from the corpus survive forever.
 *
 * data/sentence-blacklist.txt (one Tatoeba id per line, `#` comments) drops
 * individual sentences -- Tatoeba quality is uneven and the ids are kept
 * precisely so a bad one can be named.
 */
export async function importSentences(db: Db, corpusPath?: string): Promise<ImportResult> {
  const corpus = corpusPath === undefined ? await readDataFile("sentences.json") : await readPath(corpusPath);
  if (corpus === null) throw new Error("Missing data/sentences.json");
  const expected = await readDataFile("sentences-bank.json");
  if (expected === null) throw new Error("Missing data/sentences-bank.json");
  return importSentencesFrom(db, {
    corpus: JSON.parse(corpus) as CorpusSentence[],
    blacklist: await readDataFile("sentence-blacklist.txt"),
    expected: JSON.parse(expected) as SentenceBank,
  });
}

/** data/sentences-bank.json: the bank identity the corpus was built against. */
export interface SentenceBank { items: number; fingerprint: string }

/** importSentences()'s inputs, already loaded (parsed JSON, blacklist as text). */
export interface SentenceFiles {
  corpus: CorpusSentence[];
  /** data/sentence-blacklist.txt; null/absent = nothing blacklisted. */
  blacklist?: string | null;
  expected: SentenceBank;
}

/** importSentences() over loaded contents, so it runs where there is no filesystem. */
export function importSentencesFrom(db: Db, files: SentenceFiles): ImportResult {
  const corpus = files.corpus;
  const blacklist = new Set<number>(
    (files.blacklist ?? "")
      .split("\n").map((l) => Number.parseInt(l.split("#")[0]!.trim(), 10))
      .filter((n) => Number.isInteger(n)),
  );

  // IDENTITY, not existence.
  //
  // The corpus keys words by bank item id, and seed() assigns ids in INSERT
  // order. A user who seeded before a CSV row was added and re-seeded after
  // gets that word an id at the END, shifting every later word by one — and an
  // existence check cannot see it, because all 1384 ids still exist. Measured
  // on exactly that bank: 1184/1384 ids named a different word, 43,457
  // sentences imported without a murmur, and 3,828 of the first 4,000 were
  // linked to a word that does not occur in them —「何してるの？」answered by
  // 座る【すわる】. Compare the fingerprint of the whole bank instead.
  const bank = bankFingerprint(db);
  const items = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM items").get()!.n;
  if (items === 0) throw new Error("No items in the bank — run `bun run seed` first.");
  const expected = files.expected;
  if (bank !== expected.fingerprint) {
    throw new Error(
      `This database's item bank is not the one data/sentences.json was built against.\n` +
      `  expected ${expected.fingerprint.slice(0, 16)}… over ${expected.items} items\n` +
      `  this db  ${bank.slice(0, 16)}… over ${items} items\n` +
      "Every sentence links words by item id, so importing would ask you the meaning of\n" +
      "words that are not in the audio. Ids are assigned by INSERT order, so this happens\n" +
      "when the CSVs changed between seeds. Rebuild the bank from scratch (a fresh\n" +
      "database, then `bun run seed`), or rebuild the corpus with tools/build_sentences.py.");
  }

  // Existence is now implied by the fingerprint, but a corpus row naming an id
  // outside the bank would still be a corpus bug rather than a bank bug.
  const known = new Set(db.query<{ id: number }, []>("SELECT id FROM items").all().map((r) => r.id));
  for (const s of corpus) {
    for (const i of [...s.items, ...s.ambiguous]) {
      if (!known.has(i)) {
        throw new Error(
          `Corpus references item ${i}, which is not in the bank (sentence ${s.id}). ` +
          "The corpus was built against a different bank; rebuild it with tools/build_sentences.py.");
      }
    }
  }

  const insS = db.query(
    "INSERT INTO sentences (id, ja, en, author, n_items, n_unheard) VALUES (?,?,?,?,?,?)");
  const insI = db.query(
    "INSERT INTO sentence_items (sentence_id, item_id, ambiguous) VALUES (?,?,?)");

  let sentences = 0, links = 0, blacklisted = 0;
  db.transaction(() => {
    db.exec("DELETE FROM sentence_items; DELETE FROM sentences;");
    for (const s of corpus) {
      if (blacklist.has(s.id)) { blacklisted++; continue; }
      const n = s.items.length + s.ambiguous.length;
      // n_unheard is set by the recompute below, not carried over from a
      // previous import: it is a function of the CURRENT cards state.
      insS.run(s.id, s.ja, s.en, s.author, n, n);
      for (const i of s.items) insI.run(s.id, i, 0);
      for (const i of s.ambiguous) insI.run(s.id, i, 1);
      sentences++; links += n;
    }
    recomputeUnheard(db);
    // Stamp the bank these links belong to, so a later seed() that changes the
    // bank identity knows to drop them instead of serving them.
    setSetting(db, BANK_FINGERPRINT_KEY, bank);
  })();

  return { sentences, links, blacklisted };
}

/**
 * How much of the listening deck currently has a sentence available.
 * The premise of this whole feature is corpus coverage, so it stays measured.
 */
export function sentenceCoverage(db: Db): {
  listening: number; withSentence: number; distinct: number;
} {
  const eligible = `
    FROM cards c
   WHERE c.mode = 'listening' AND c.introduced = 1
     AND EXISTS (SELECT 1 FROM sentence_items si JOIN sentences s ON s.id = si.sentence_id
                  WHERE si.item_id = c.item_id AND si.ambiguous = 0
                    AND s.n_unheard = (CASE WHEN c.state <> 'learning' THEN 0 ELSE 1 END))`;
  const listening = db.query<{ n: number }, []>(
    "SELECT COUNT(*) AS n FROM cards WHERE mode='listening' AND introduced=1").get()!.n;
  const withSentence = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n ${eligible}`).get()!.n;
  const distinct = db.query<{ n: number }, []>(`
    SELECT COUNT(DISTINCT si.sentence_id) AS n
      FROM sentence_items si JOIN sentences s ON s.id = si.sentence_id
      JOIN cards c ON c.item_id = si.item_id AND c.mode = 'listening' AND c.introduced = 1
     WHERE si.ambiguous = 0
       AND s.n_unheard = (CASE WHEN c.state <> 'learning' THEN 0 ELSE 1 END)`).get()!.n;
  return { listening, withSentence, distinct };
}

/**
 * Plan section 6: enable sentence stimuli once roughly half of listening cards
 * have one. Below that, most listening reviews would still play the bare word,
 * so turning it on changes little except the risk of forgetting it is on.
 */
export const SENTENCE_NUDGE_SHARE = 0.5;
/** Set while the nudge has been shown for the current crossing; cleared below it. */
export const SENTENCE_NUDGE_KEY = "sentence_nudge_shown";

/**
 * Whether to print the enable-sentences nudge, and what the shown flag should
 * become. Pure so the once-per-crossing rule is testable without a CLI.
 * Dropping back below the threshold (a reimport, a blacklist) clears the flag,
 * so the next crossing is announced again rather than silently swallowed.
 */
export function sentenceNudge(s: {
  enabled: boolean; listening: number; withSentence: number; shown: boolean;
}): { show: boolean; shown: boolean } {
  if (s.enabled) return { show: false, shown: s.shown };
  const reached = s.listening > 0 && s.withSentence / s.listening >= SENTENCE_NUDGE_SHARE;
  if (!reached) return { show: false, shown: false };
  return { show: !s.shown, shown: true };
}

/**
 * The one-line nudge if it is due, recording that it was shown. Callers must
 * not call this on --json paths: it consumes the once-per-crossing flag.
 */
export function sentenceNudgeLine(db: Db): string | null {
  const cov = sentenceCoverage(db);
  const shown = getSetting(db, SENTENCE_NUDGE_KEY, "0") === "1";
  const d = sentenceNudge({ enabled: sentencesEnabled(db), ...cov, shown });
  if (d.shown !== shown) setSetting(db, SENTENCE_NUDGE_KEY, d.shown ? "1" : "0");
  if (!d.show) return null;
  const pct = Math.round((cov.withSentence / cov.listening) * 100);
  return `${cov.withSentence}/${cov.listening} listening cards (${pct}%) now have a sentence. Enable with: bun run cli set ${SENTENCE_SETTING} 1`;
}

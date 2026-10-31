/**
 * Choosing the next card, with one app-specific rule on top of nextQuestion:
 * never serve a listening card that cannot be heard.
 *
 * Scheduling stays in quiz.ts. This only decides what to do when the card
 * nextQuestion picked is unplayable: ask nextQuestion again, restricted to each
 * non-listening mode, and take the most overdue of those -- the order
 * nextQuestion itself would have used had listening not existed.
 */
import type { Db } from "../../../src/sqlite";
import { nextQuestion, dueCount, humanInterval, introducedByMode, modePriority,
  parseModeWeights, type Question } from "../../../src/quiz";
import { getSetting, MODES, type Mode } from "../../../src/schema";
import type { Level } from "./context";

export interface Pick {
  q: Question | null;
  /** Listening cards due now that were passed over for lack of audio. */
  listeningWaiting: number;
}

export function pickQuestion(db: Db, level: Level, mode: Mode | "any", canHear: boolean, now = Date.now()): Pick {
  const listeningWaiting = canHear ? 0 : dueListening(db, level, now);
  if (canHear) return { q: nextQuestion(db, { level, mode, now }), listeningWaiting };
  if (mode === "listening") return { q: null, listeningWaiting };
  if (mode !== "any") return { q: nextQuestion(db, { level, mode, now }), listeningWaiting };

  const first = nextQuestion(db, { level, mode, now });
  if (!first || first.mode !== "listening") return { q: first, listeningWaiting };

  const candidates = MODES.filter((m) => m !== "listening")
    .map((m) => nextQuestion(db, { level, mode: m, now }))
    .filter((q): q is Question => q !== null);
  // Due reviews before new cards, as nextQuestion does; among reviews, most
  // overdue first; among new cards, the mode furthest below its target mix.
  const reviews = candidates.filter((q) => !q.isNew);
  if (reviews.length) {
    const due = (q: Question) => db.query<{ due: number }, [number, string]>(
      "SELECT due FROM cards WHERE item_id = ? AND mode = ?").get(q.itemId, q.mode)?.due ?? Infinity;
    reviews.sort((a, b) => due(a) - due(b));
    return { q: reviews[0]!, listeningWaiting };
  }
  const order = modePriority(introducedByMode(db), parseModeWeights(getSetting(db, "mode_weights", "")));
  candidates.sort((a, b) => order.indexOf(a.mode) - order.indexOf(b.mode));
  return { q: candidates[0] ?? null, listeningWaiting };
}

function dueListening(db: Db, level: Level, now: number): number {
  const lv = level === "both" ? "" : " AND i.level = ?";
  const params: (string | number)[] = [now, ...(level === "both" ? [] : [level])];
  return db.query<{ n: number }, (string | number)[]>(
    `SELECT COUNT(*) AS n FROM cards c JOIN items i ON i.id = c.item_id
      WHERE c.introduced = 1 AND c.mode = 'listening' AND c.due <= ?${lv}`).get(...params)!.n;
}

/**
 * Why there is nothing to study, and when there will be. Same wording rules
 * as cli.ts cmdNext: "come back tomorrow" is wrong whenever a taught card is
 * due in minutes (introduceCard schedules the first test 10 minutes out), and
 * the raise-the-limit hint is derived from the current limit, never a constant.
 */
export function nothingDue(db: Db, now = Date.now()): { title: string; detail: string; soonest: number | null } {
  const s = dueCount(db, now);
  const limit = Number.parseInt(getSetting(db, "new_per_day", "5"), 10);
  const soonest = db.query<{ due: number | null }, [number]>(
    "SELECT MIN(due) AS due FROM cards WHERE introduced = 1 AND due > ?").get(now)?.due ?? null;
  const wait = soonest ? humanInterval(soonest - now) : null;
  if (s.unseen > 0) {
    return {
      title: wait ? `Next card in ${wait}` : "Come back tomorrow",
      detail: `Nothing due right now. Today's new-card limit (${limit}) is reached.`
        + ` Raise it to ${limit + 4} in Settings for more new words.`,
      soonest,
    };
  }
  return wait
    ? { title: `Next card in ${wait}`, detail: "Nothing due right now; every card has been introduced.", soonest }
    : { title: "All done", detail: "Nothing due and every card introduced. Come back later.", soonest: null };
}

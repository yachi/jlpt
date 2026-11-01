/**
 * The day as a finite task: how much of today's study is done, how much is
 * left, and the streak of days studied.
 *
 * Everything is derived from what the database already records (the review
 * log and cards.introduced_at), so there is no new table to migrate, a backup
 * carries the streak with it, and the CLI's sessions count toward it too.
 *
 * Read-only: nothing here writes, so it can be called on every redraw.
 */
import { dueCount } from "../../../src/quiz";
import { getSetting } from "../../../src/schema";
import type { Db } from "../../../src/sqlite";

export function startOfDay(t: number): number { return new Date(t).setHours(0, 0, 0, 0); }
function endOfDay(t: number): number { return new Date(t).setHours(24, 0, 0, 0); }
/** Local calendar date, so DST days (23h/25h) still advance by exactly one. */
export function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function nextDay(t: number): number { const d = new Date(t); d.setDate(d.getDate() + 1); return d.setHours(0, 0, 0, 0); }

/**
 * Seconds a card takes, end to end. The review log stores thinking time only;
 * reading the feedback and tapping Next is roughly a few seconds more. Median,
 * not mean: one card left on screen during a phone call must not double the
 * estimate.
 */
const FEEDBACK_SECONDS = 4;
const DEFAULT_THINK_SECONDS = 6;

export function secondsPerCard(db: Db): number {
  const rows = db.query<{ e: number }, []>(
    "SELECT elapsed_ms AS e FROM reviews WHERE elapsed_ms IS NOT NULL ORDER BY id DESC LIMIT 200").all();
  if (rows.length < 5) return DEFAULT_THINK_SECONDS + FEEDBACK_SECONDS;
  const sorted = rows.map((r) => r.e).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]! / 1000;
  return Math.min(60, median) + FEEDBACK_SECONDS;
}

export interface TodayPlan {
  /** Steps done today: answers graded plus new words taught. */
  done: number;
  /** Steps still to come today: due now, coming due before midnight, new words left. */
  remaining: number;
  /** done + remaining: today's goal, as the learner sees it. */
  goal: number;
  /** Whole minutes for `remaining`, at least 1 while anything remains. */
  minutesLeft: number;
  answered: number;
  correct: number;
  taught: number;
  /** Thinking time today, from the review log. */
  studyMs: number;
}

/**
 * Today's work, counted in the steps the learner actually takes.
 *
 * A new word with "teach first" on is two steps: the teach screen now, and its
 * first test ten minutes later. Counting it as one would make the goal grow
 * mid-session, which reads as moving the finish line.
 */
export interface PlanFilter {
  level?: "N5" | "N4" | "both";
  mode?: string;
  /** false: listening cards are skipped (no voice), so they are not today's work. */
  canHear?: boolean;
}

/**
 * Cards the study screen would actually serve, as SQL on `cards c JOIN items i`.
 * Without this a level/mode filter, or listening cards skipped for lack of a
 * voice, would leave work in the count that can never be done, and the day
 * could never finish.
 */
function servable(f: PlanFilter): { sql: string; params: string[] } {
  const parts: string[] = [], params: string[] = [];
  if (f.level && f.level !== "both") { parts.push("i.level = ?"); params.push(f.level); }
  if (f.mode && f.mode !== "any") { parts.push("c.mode = ?"); params.push(f.mode); }
  if (f.canHear === false) parts.push("c.mode <> 'listening'");
  return { sql: parts.map((p) => ` AND ${p}`).join(""), params };
}

export function todayPlan(db: Db, now = Date.now(), filter: PlanFilter = {}): TodayPlan {
  const sod = startOfDay(now), eod = endOfDay(now);
  const f = servable(filter);
  const r = db.query<{ n: number; c: number; ms: number }, [number]>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(correct), 0) AS c,
            COALESCE(SUM(MIN(COALESCE(elapsed_ms, 0), 60000)), 0) AS ms
       FROM reviews WHERE ts >= ?`).get(sod)!;
  const taught = db.query<{ n: number }, [number]>(
    "SELECT COUNT(*) AS n FROM cards WHERE introduced_at >= ?").get(sod)!.n;
  const s = dueCount(db, now);
  const count = (where: string, ...p: number[]) => db.query<{ n: number }, (number | string)[]>(
    `SELECT COUNT(*) AS n FROM cards c JOIN items i ON i.id = c.item_id WHERE c.introduced = 1 AND ${where}${f.sql}`)
    .get(...p, ...f.params)!.n;
  const dueNow = count("c.due <= ?", now);
  const later = count("c.due > ? AND c.due < ?", now, eod);
  const limit = Number.parseInt(getSetting(db, "new_per_day", "5"), 10);
  const newLeft = Math.max(0, Math.min((Number.isFinite(limit) ? limit : 5) - taught, s.unseen));
  const teachFirst = getSetting(db, "teach_new_first", "1") === "1";
  const remaining = dueNow + later + newLeft * (teachFirst ? 2 : 1);
  const done = r.n + taught;
  return {
    done, remaining, goal: done + remaining,
    minutesLeft: remaining ? Math.max(1, Math.round((remaining * secondsPerCard(db)) / 60)) : 0,
    answered: r.n, correct: r.c, taught, studyMs: r.ms,
  };
}

export interface Streak {
  /** Days in the current run, today included once studied. 0 = no run. */
  days: number;
  /** Freezes in hand: each covers one missed day automatically. */
  freezes: number;
  /** Whether today already counts. */
  today: boolean;
}

/**
 * A forgiving streak (see the research doc: Silverman & Barasch 2023; Lally
 * et al. 2010 found one missed day does not hurt habit formation).
 *
 *  - Any study at all keeps the day: one answer or one word taught. A high bar
 *    is what kept Duolingo's most ambitious learners off a streak.
 *  - A run starts with one freeze and earns another every 7 days studied, at
 *    most 2. A missed day spends a freeze and the run carries on.
 *  - Today never breaks the run before midnight: it is simply not counted yet.
 *
 * A run that does break just ends; the UI never shows a "lost streak".
 */
export const MAX_FREEZES = 2;
export const EARN_EVERY = 7;

export function streak(db: Db, now = Date.now()): Streak {
  const rows = db.query<{ t: number }, []>(
    `SELECT ts AS t FROM reviews UNION ALL
     SELECT introduced_at AS t FROM cards WHERE introduced_at IS NOT NULL`).all();
  const active = new Set(rows.map((r) => dayKey(r.t)));
  if (!active.size) return { days: 0, freezes: 0, today: false };
  const first = Math.min(...rows.map((r) => r.t));
  const today = startOfDay(now);

  let days = 0, freezes = 0, studied = 0;
  for (let d = startOfDay(first); d < today; d = nextDay(d)) {
    if (active.has(dayKey(d))) {
      if (days === 0) { freezes = 1; studied = 0; }
      days++; studied++;
      if (studied % EARN_EVERY === 0) freezes = Math.min(MAX_FREEZES, freezes + 1);
    } else if (days > 0 && freezes > 0) {
      freezes--;
    } else {
      days = 0; freezes = 0;
    }
  }
  const studiedToday = active.has(dayKey(today));
  if (studiedToday) {
    if (days === 0) { freezes = 1; studied = 0; }
    days++; studied++;
    if (studied % EARN_EVERY === 0) freezes = Math.min(MAX_FREEZES, freezes + 1);
  }
  return { days, freezes, today: studiedToday };
}

/** Cards due by the end of tomorrow that are not due today, for the done screen. */
export function dueTomorrow(db: Db, now = Date.now()): number {
  const eod = endOfDay(now);
  return db.query<{ n: number }, [number, number]>(
    "SELECT COUNT(*) AS n FROM cards WHERE introduced = 1 AND due >= ? AND due < ?").get(eod, endOfDay(eod))!.n;
}

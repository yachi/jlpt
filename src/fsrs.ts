/**
 * FSRS-6 scheduler — a direct TypeScript port of the reference implementation
 * open-spaced-repetition/py-fsrs `fsrs/scheduler.py` (MIT).
 *
 * Ported verbatim from source rather than from prose descriptions: several
 * third-party write-ups of FSRS-6 state the stability formulas incorrectly.
 * Cross-validated against py-fsrs itself in src/fsrs.test.ts.
 */

export const FSRS_DEFAULT_DECAY = 0.1542;

export const DEFAULT_PARAMETERS: readonly number[] = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666,
  0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658,
  FSRS_DEFAULT_DECAY,
];

const STABILITY_MIN = 0.001;
const MIN_DIFFICULTY = 1.0;
const MAX_DIFFICULTY = 10.0;

/** 1=Again 2=Hard 3=Good 4=Easy */
export type Rating = 1 | 2 | 3 | 4;
export type CardState = "learning" | "review" | "relearning";

export interface Card {
  stability: number | null;
  difficulty: number | null;
  state: CardState;
  /** index into learning_steps / relearning_steps; null once in review */
  step: number | null;
  /** epoch ms */
  due: number;
  /** epoch ms, null if never reviewed */
  lastReview: number | null;
}

export function newCard(now = Date.now()): Card {
  return { stability: null, difficulty: null, state: "learning", step: 0, due: now, lastReview: null };
}

const MIN = 60_000;
const DAY = 86_400_000;

export interface SchedulerOptions {
  parameters?: readonly number[];
  desiredRetention?: number;
  /** in ms */
  learningSteps?: number[];
  relearningSteps?: number[];
  maximumInterval?: number;
  enableFuzzing?: boolean;
}

export class Scheduler {
  readonly parameters: readonly number[];
  readonly desiredRetention: number;
  readonly learningSteps: number[];
  readonly relearningSteps: number[];
  readonly maximumInterval: number;
  readonly enableFuzzing: boolean;
  private readonly DECAY: number;
  private readonly FACTOR: number;

  constructor(o: SchedulerOptions = {}) {
    this.parameters = o.parameters ?? DEFAULT_PARAMETERS;
    if (this.parameters.length !== 21) throw new Error(`Expected 21 parameters, got ${this.parameters.length}`);
    this.desiredRetention = o.desiredRetention ?? 0.9;
    this.learningSteps = o.learningSteps ?? [1 * MIN, 10 * MIN];
    this.relearningSteps = o.relearningSteps ?? [10 * MIN];
    this.maximumInterval = o.maximumInterval ?? 36500;
    this.enableFuzzing = o.enableFuzzing ?? true;
    this.DECAY = -this.parameters[20]!;
    this.FACTOR = Math.pow(0.9, 1 / this.DECAY) - 1;
  }

  /** Predicted probability of correct recall right now. */
  retrievability(card: Card, now = Date.now()): number {
    if (card.lastReview === null || card.stability === null) return 0;
    const elapsedDays = Math.max(0, Math.floor((now - card.lastReview) / DAY));
    return Math.pow(1 + (this.FACTOR * elapsedDays) / card.stability, this.DECAY);
  }

  private clampD(d: number) { return Math.min(Math.max(d, MIN_DIFFICULTY), MAX_DIFFICULTY); }
  private clampS(s: number) { return Math.max(s, STABILITY_MIN); }

  private initialStability(rating: Rating) { return this.clampS(this.parameters[rating - 1]!); }

  private initialDifficulty(rating: Rating, clamp: boolean) {
    const d = this.parameters[4]! - Math.exp(this.parameters[5]! * (rating - 1)) + 1;
    return clamp ? this.clampD(d) : d;
  }

  private nextInterval(stability: number): number {
    let ivl = (stability / this.FACTOR) * (Math.pow(this.desiredRetention, 1 / this.DECAY) - 1);
    ivl = Math.round(ivl);
    return Math.min(Math.max(ivl, 1), this.maximumInterval);
  }

  private shortTermStability(stability: number, rating: Rating): number {
    let inc = Math.exp(this.parameters[17]! * (rating - 3 + this.parameters[18]!)) *
      Math.pow(stability, -this.parameters[19]!);
    if (rating >= 2) inc = Math.max(inc, 1.0);
    return this.clampS(stability * inc);
  }

  private nextDifficulty(difficulty: number, rating: Rating): number {
    const deltaD = -(this.parameters[6]! * (rating - 3));
    const damped = difficulty + ((10.0 - difficulty) * deltaD) / 9.0;
    const arg1 = this.initialDifficulty(4, false);
    const next = this.parameters[7]! * arg1 + (1 - this.parameters[7]!) * damped;
    return this.clampD(next);
  }

  private nextForgetStability(difficulty: number, stability: number, r: number): number {
    const longTerm =
      this.parameters[11]! *
      Math.pow(difficulty, -this.parameters[12]!) *
      (Math.pow(stability + 1, this.parameters[13]!) - 1) *
      Math.exp((1 - r) * this.parameters[14]!);
    const shortTerm = stability / Math.exp(this.parameters[17]! * this.parameters[18]!);
    return Math.min(longTerm, shortTerm);
  }

  private nextRecallStability(difficulty: number, stability: number, r: number, rating: Rating): number {
    const hardPenalty = rating === 2 ? this.parameters[15]! : 1;
    const easyBonus = rating === 4 ? this.parameters[16]! : 1;
    return (
      stability *
      (1 +
        Math.exp(this.parameters[8]!) *
          (11 - difficulty) *
          Math.pow(stability, -this.parameters[9]!) *
          (Math.exp((1 - r) * this.parameters[10]!) - 1) *
          hardPenalty *
          easyBonus)
    );
  }

  private nextStability(difficulty: number, stability: number, r: number, rating: Rating): number {
    const s = rating === 1
      ? this.nextForgetStability(difficulty, stability, r)
      : this.nextRecallStability(difficulty, stability, r, rating);
    return this.clampS(s);
  }

  private fuzz(intervalDays: number, rng: () => number): number {
    if (intervalDays < 2.5) return intervalDays;
    const ranges = [
      { start: 2.5, end: 7.0, factor: 0.15 },
      { start: 7.0, end: 20.0, factor: 0.1 },
      { start: 20.0, end: Infinity, factor: 0.05 },
    ];
    let delta = 1.0;
    for (const r of ranges) delta += r.factor * Math.max(Math.min(intervalDays, r.end) - r.start, 0.0);
    let minI = Math.max(2, Math.round(intervalDays - delta));
    let maxI = Math.min(Math.round(intervalDays + delta), this.maximumInterval);
    minI = Math.min(minI, maxI);
    return Math.min(Math.round(rng() * (maxI - minI + 1) + minI), this.maximumInterval);
  }

  /**
   * Review a card. Returns a NEW card object; the input is not mutated.
   * `rng` is injectable so tests can disable fuzz nondeterminism.
   */
  review(card: Card, rating: Rating, now = Date.now(), rng: () => number = Math.random): Card {
    const c: Card = { ...card };
    const daysSince = c.lastReview === null ? null : Math.floor((now - c.lastReview) / DAY);
    let nextIntervalMs = 0;

    const toReviewState = () => {
      c.state = "review";
      c.step = null;
      nextIntervalMs = this.nextInterval(c.stability!) * DAY;
    };

    const updateSD = () => {
      if (c.stability === null || c.difficulty === null) {
        c.stability = this.initialStability(rating);
        c.difficulty = this.initialDifficulty(rating, true);
      } else if (daysSince !== null && daysSince < 1) {
        c.stability = this.shortTermStability(c.stability, rating);
        c.difficulty = this.nextDifficulty(c.difficulty, rating);
      } else {
        const r = this.retrievability(card, now);
        c.stability = this.nextStability(c.difficulty, c.stability, r, rating);
        c.difficulty = this.nextDifficulty(c.difficulty, rating);
      }
    };

    const walkSteps = (steps: number[]) => {
      if (steps.length === 0 || (c.step! >= steps.length && rating >= 2)) { toReviewState(); return; }
      switch (rating) {
        case 1:
          c.step = 0;
          nextIntervalMs = steps[0]!;
          break;
        case 2:
          if (c.step === 0 && steps.length === 1) nextIntervalMs = steps[0]! * 1.5;
          else if (c.step === 0 && steps.length >= 2) nextIntervalMs = (steps[0]! + steps[1]!) / 2;
          else nextIntervalMs = steps[c.step!]!;
          break;
        case 3:
          if (c.step! + 1 === steps.length) toReviewState();
          else { c.step = c.step! + 1; nextIntervalMs = steps[c.step]!; }
          break;
        case 4:
          toReviewState();
          break;
      }
    };

    if (c.state === "learning") {
      updateSD();
      walkSteps(this.learningSteps);
    } else if (c.state === "review") {
      if (daysSince !== null && daysSince < 1) c.stability = this.shortTermStability(c.stability!, rating);
      else c.stability = this.nextStability(c.difficulty!, c.stability!, this.retrievability(card, now), rating);
      c.difficulty = this.nextDifficulty(c.difficulty!, rating);

      if (rating === 1) {
        if (this.relearningSteps.length === 0) { nextIntervalMs = this.nextInterval(c.stability) * DAY; }
        else { c.state = "relearning"; c.step = 0; nextIntervalMs = this.relearningSteps[0]!; }
      } else {
        nextIntervalMs = this.nextInterval(c.stability) * DAY;
      }
    } else {
      updateSD();
      walkSteps(this.relearningSteps);
    }

    if (this.enableFuzzing && c.state === "review") {
      nextIntervalMs = this.fuzz(nextIntervalMs / DAY, rng) * DAY;
    }

    c.due = now + nextIntervalMs;
    c.lastReview = now;
    return c;
  }
}

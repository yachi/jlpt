/**
 * Study: one card at a time, the same loop as cli.ts cmdStudy.
 *
 * Every decision about WHAT to ask and HOW it scores is a core call
 * (nextQuestion, introduceCard, grade); this file only measures the answer
 * time and draws. The one thing the app adds is pick.ts's rule that an
 * unplayable listening card is skipped rather than served silent.
 */
import { grade, hasAudioStimulus, introduceCard, humanInterval, DONT_KNOW,
  type Question, type GradeResult } from "../../../src/quiz";
import { romajiToKana } from "../../../src/romaji";
import { h, mount, revealBlock } from "./dom";
import { getSetting, setSetting } from "../../../src/schema";
import { getLevel, getMode, MODE_LABEL, type Ctx } from "./context";
import { pickQuestion, nothingDue } from "./pick";
import { todayPlan, streak, dueTomorrow, dayKey, type TodayPlan } from "./today";
import { pop, shake, enter, countUp, celebrate, haptic, chime, reducedMotion, APP_STREAK_KEY } from "./fx";

/**
 * Thinking time for one card.
 *
 * Starts when the question is on screen, or -- for a card whose audio is the
 * question -- when that audio finishes, exactly where cli.ts takes `t0`. A
 * replay is NOT a restart: the CLI charges `r` to the same clock and
 * slowThresholdFor() already budgets one replay.
 *
 * Time with the app in the background is not counted. A terminal cannot be
 * backgrounded mid-prompt the way a phone is by a call or a notification, and
 * counting that would rate a card Hard for something the learner never saw.
 */
class AnswerClock {
  private t0 = performance.now();
  private hiddenAt: number | null = null;
  private hiddenTotal = 0;
  private readonly onVis = () => {
    if (document.hidden) this.hiddenAt = performance.now();
    else if (this.hiddenAt !== null) { this.hiddenTotal += performance.now() - this.hiddenAt; this.hiddenAt = null; }
  };
  constructor() { document.addEventListener("visibilitychange", this.onVis); }
  restart(): void { this.t0 = performance.now(); this.hiddenTotal = 0; this.hiddenAt = document.hidden ? this.t0 : null; }
  elapsed(): number {
    const hidden = this.hiddenTotal + (this.hiddenAt !== null ? performance.now() - this.hiddenAt : 0);
    return Math.max(0, Math.round(performance.now() - this.t0 - hidden));
  }
  dispose(): void { document.removeEventListener("visibilitychange", this.onVis); }
}

/**
 * Move focus to the obvious next button only with a keyboard/mouse. On a touch
 * screen a programmatic focus paints a focus ring the learner never asked for.
 */
function focusIfPointer(el: HTMLElement): void {
  if (matchMedia("(pointer: fine)").matches) el.focus();
}

/** cli.ts plays at -10% for study and -20% for the post-miss replay. */
const RATE = 0.9;
const RATE_SLOW = 0.8;

/** Last drawn fill of the day bar, so a redraw animates from it, not from 0. */
let lastFill = 0;
/** settings key: the day (dayKey) the done screen last celebrated. */
const CELEBRATED_KEY = "app_celebrated";

export function studyScreen(ctx: Ctx, root: HTMLElement): () => void {
  let asked = 0, right = 0;
  let disposers: (() => void)[] = [];
  const cleanup = () => { for (const d of disposers) d(); disposers = []; };

  /** Speak, and on failure downgrade the session to no-listening (see Ctx.audio). */
  async function say(text: string, rate = RATE): Promise<boolean> {
    if (!ctx.audio.ok) return false;
    const ok = await ctx.platform.speak(text, { rate }).catch(() => false);
    if (!ok) ctx.audio.ok = false;
    return ok;
  }

  /**
   * Today as a finite task: "8 of 17 done", minutes left, and a bar that fills.
   * The goal is the FSRS queue plus today's new words, never an invented
   * number of points, so finishing it is exactly the work that helps memory.
   */
  function header(): HTMLElement {
    const plan = todayPlan(ctx.db, Date.now(), planFilter());
    const fill = h("div", { class: "day-fill" });
    const el = h("div", { class: "today" },
      h("div", { class: "session" },
        h("span", { class: "today-count" }, todayLabel(plan)),
        h("span", { class: "today-right" }, streakChip(), h("span", { class: "today-left" }, leftLabel(plan)))),
      h("div", { class: "day-bar", role: "progressbar", "aria-label": "Today's study",
        "aria-valuemin": "0", "aria-valuemax": String(plan.goal), "aria-valuenow": String(plan.done) }, fill));
    setFill(fill, plan);
    return el;
  }

  function planFilter() {
    return { level: getLevel(ctx.db), mode: getMode(ctx.db), canHear: ctx.audio.ok };
  }

  function todayLabel(p: TodayPlan): string {
    return p.goal ? `Today ${p.done} of ${p.goal}` : "Today";
  }
  function leftLabel(p: TodayPlan): string {
    return p.remaining ? `~${p.minutesLeft} min left` : "Done";
  }
  function setFill(fill: HTMLElement, p: TodayPlan): void {
    const to = p.goal ? p.done / p.goal : 0;
    fill.style.transform = `scaleX(${lastFill})`;
    // Next frame, so the transition runs from the last value to the new one.
    requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.transform = `scaleX(${to})`; }));
    lastFill = to;
  }
  function streakChip(): HTMLElement | null {
    if (getSetting(ctx.db, APP_STREAK_KEY, "1") !== "1") return null;
    const s = streak(ctx.db);
    if (!s.days) return null;
    return h("span", { class: `streak${s.today ? " lit" : ""}`,
      title: s.today ? "Today counts" : "Study today to keep it going",
      "aria-label": `${s.days} day streak${s.today ? "" : ", today not yet studied"}` },
      h("span", { class: "flame", "aria-hidden": "true" }, "🔥"), String(s.days));
  }

  /** Update the header in place after an answer, so the bar animates. */
  function refreshHeader(): void {
    const old = root.querySelector<HTMLElement>(".today");
    if (!old) return;
    const p = todayPlan(ctx.db, Date.now(), planFilter());
    old.querySelector(".today-count")!.textContent = todayLabel(p);
    old.querySelector(".today-left")!.textContent = leftLabel(p);
    old.querySelector(".streak")?.remove();
    const chip = streakChip();
    if (chip) old.querySelector(".today-right")!.prepend(chip);
    const bar = old.querySelector<HTMLElement>(".day-bar")!;
    bar.setAttribute("aria-valuemax", String(p.goal));
    bar.setAttribute("aria-valuenow", String(p.done));
    setFill(old.querySelector<HTMLElement>(".day-fill")!, p);
  }

  function audioNotice(waiting: number): HTMLElement | null {
    if (ctx.audio.ok) return null;
    return h("div", { class: "notice" },
      h("p", null, h("strong", null, "No Japanese voice. "),
        "Listening cards are skipped, not served silent",
        waiting ? ` (${waiting} waiting).` : "."),
      h("button", { class: "link", type: "button", onclick: () => ctx.openVoiceSettings() },
        "Install Japanese voice data"));
  }

  function next(): void {
    cleanup();
    const { q, listeningWaiting } = pickQuestion(ctx.db, getLevel(ctx.db), getMode(ctx.db), ctx.audio.ok);
    if (!q) return emptyView(listeningWaiting);
    if (q.teachFirst) return teachView(q, listeningWaiting);
    questionView(q, listeningWaiting);
  }

  function emptyView(waiting: number): void {
    const plan = todayPlan(ctx.db, Date.now(), planFilter());
    if (plan.remaining === 0 && plan.done > 0) return doneView(plan, waiting);
    const n = nothingDue(ctx.db);
    // Wake up on our own when the next card lands soon: a taught word is due
    // ten minutes later, and making the learner guess when to tap is friction.
    if (n.soonest !== null && n.soonest - Date.now() < 3_600_000) {
      const t = setTimeout(next, Math.max(1000, n.soonest - Date.now() + 500));
      disposers.push(() => clearTimeout(t));
    }
    mount(root,
      header(), audioNotice(waiting),
      h("section", { class: "card empty" },
        h("h2", null, n.title),
        // Cards still to come today are relearning steps (a miss, or a word
        // just taught): say that, so the wait reads as part of the plan.
        h("p", { class: "muted" }, plan.remaining
          ? `${plan.remaining} card${plan.remaining === 1 ? "" : "s"} come${plan.remaining === 1 ? "s" : ""} back later today for another try. The screen moves on by itself.`
          : n.detail),
        asked ? h("p", { class: "summary" },
          `This session: ${right}/${asked} correct (${Math.round((right / asked) * 100)}%)`) : null),
      h("div", { class: "actions sticky" },
        h("button", { class: "btn", type: "button", onclick: next }, "Check again")));
  }

  /**
   * The day is finished: close it clearly (a ring that completes, today's
   * numbers, what comes tomorrow). No "one more" button: extra reviews before
   * they are due barely help memory, and a clear finish is the reward.
   */
  function doneView(plan: TodayPlan, waiting: number): void {
    const now = Date.now();
    const n = nothingDue(ctx.db, now);
    const tomorrow = dueTomorrow(ctx.db, now);
    const s = streak(ctx.db, now);
    const showStreak = getSetting(ctx.db, APP_STREAK_KEY, "1") === "1" && s.days > 0;
    const acc = plan.answered ? Math.round((plan.correct / plan.answered) * 100) : 0;
    const mins = Math.max(1, Math.round(plan.studyMs / 60000));

    const R = 52, C = 2 * Math.PI * R;
    const ring = h("div", { class: "ring", "aria-hidden": "true" });
    ring.innerHTML = `<svg viewBox="0 0 120 120"><circle class="ring-bg" cx="60" cy="60" r="${R}"/>`
      + `<circle class="ring-fg" cx="60" cy="60" r="${R}" stroke-dasharray="${C}" stroke-dashoffset="${C}"/>`
      + `<path class="ring-check" d="M40 62 l14 14 l27 -30" pathLength="1"/></svg>`;

    const stat = (value: number, label: string, fmt: (n: number) => string = String) => {
      const v = h("div", { class: "stat-v" });
      countUp(v, value, fmt);
      return h("div", { class: "stat" }, v, h("div", { class: "stat-l" }, label));
    };
    const nextLine = tomorrow
      ? `Tomorrow: ${tomorrow} card${tomorrow === 1 ? "" : "s"} due.`
      : n.soonest ? `${n.title}.` : "Nothing scheduled yet.";

    const card = h("section", { class: "card done" },
      ring,
      h("h2", null, "Done for today"),
      h("p", { class: "muted" }, nextLine),
      h("div", { class: "stats" },
        stat(plan.answered + plan.taught, plan.taught ? `cards (${plan.taught} new)` : "cards"),
        plan.answered ? stat(acc, "correct", (x) => `${x}%`) : null,
        stat(mins, mins === 1 ? "minute" : "minutes"),
        showStreak ? stat(s.days, "day streak") : null),
      showStreak && s.freezes
        ? h("p", { class: "muted small" },
            `${s.freezes} streak freeze${s.freezes === 1 ? "" : "s"} saved: a missed day won't end your streak.`)
        : null);
    mount(root, header(), audioNotice(waiting), card,
      h("div", { class: "actions sticky" },
        h("button", { class: "btn ghost", type: "button", onclick: next }, "Check again")));
    enter(card);
    // Draw the ring on the next frame so its stroke animates from empty.
    requestAnimationFrame(() => requestAnimationFrame(() => ring.classList.add("full")));

    // Celebrate once per day, and confetti only for a strong day: rewarding
    // every finish makes the reward mean nothing.
    const today = dayKey(now);
    if (getSetting(ctx.db, CELEBRATED_KEY, "") !== today) {
      setSetting(ctx.db, CELEBRATED_KEY, today);
      ctx.save();
      haptic(ctx.db, "confirm");
      if (plan.answered >= 10 && acc >= 85) setTimeout(() => void celebrate().catch(() => {}), 450);
    }
  }

  function badge(q: Question): HTMLElement {
    return h("div", { class: "badge-row" },
      h("span", { class: `badge lv-${q.level.toLowerCase()}` }, q.level),
      h("span", { class: `badge mode-${q.mode}` }, MODE_LABEL[q.mode]),
      q.isNew ? h("span", { class: "badge new" }, "NEW") : null);
  }

  // ------------------------------------------------------------ teach first

  function teachView(q: Question, waiting: number): void {
    const play = q.audioText && ctx.audio.ok
      ? h("button", { class: "btn ghost", type: "button", onclick: () => void say(q.audioText!) }, "Play again")
      : null;
    const got = h("button", { class: "btn primary big", type: "button", onclick: () => {
      // Introduction is not a measurement: introduceCard writes no review row,
      // so there is nothing to time here.
      const { due } = introduceCard(ctx.db, q.itemId, q.mode);
      ctx.save();
      haptic(ctx.db, "tick");
      ctx.toast(`First test in ${humanInterval(due - Date.now())}`);
      next();
    } }, "Got it");
    mount(root,
      header(), audioNotice(waiting),
      h("section", { class: "card" },
        badge(q),
        h("p", { class: "instruction" }, "New word: study it. It will be tested in about ten minutes."),
        revealBlock(q.reveal)),
      h("div", { class: "actions sticky" }, play, got));
    focusIfPointer(got);
    if (q.audioText) void say(q.audioText);
  }

  // ------------------------------------------------------------- questions

  function questionView(q: Question, waiting: number): void {
    const clock = new AnswerClock();
    disposers.push(() => clock.dispose());
    let answered = false;
    const feedback = h("div", { class: "feedback", "aria-live": "polite" });
    const actions = h("div", { class: "actions sticky" });
    const choiceButtons: HTMLButtonElement[] = [];
    const isJaChoice = q.mode === "reading";

    const submit = (response: string) => {
      if (answered) return;
      answered = true;
      const r = grade(ctx.db, q, response, clock.elapsed());
      ctx.save();
      asked++; if (r.correct) right++;
      showResult(q, r, response);
      refreshHeader();
    };

    const dontKnow = h("button", { class: "btn ghost", type: "button", onclick: () => submit(DONT_KNOW) },
      "I don't know");

    let body: HTMLElement;
    let input: HTMLInputElement | null = null;
    if (q.choices.length) {
      body = h("div", { class: "choices" }, q.choices.map((c, i) => {
        // Choice indices are 0-based in grade(); cli.ts subtracts 1 from what
        // the learner typed. Here the button IS the index.
        const b = h("button", { class: "choice", type: "button", onclick: () => submit(String(i)) },
          h("span", { class: "choice-n" }, String(i + 1)),
          h("span", { class: isJaChoice ? "choice-t jp" : "choice-t", lang: isJaChoice ? "ja" : null }, c));
        choiceButtons.push(b);
        return b;
      }));
    } else {
      input = h("input", {
        class: "kana-input", type: "text", lang: "ja", inputmode: "text",
        autocomplete: "off", autocapitalize: "none", autocorrect: "off", spellcheck: "false",
        enterkeyhint: "done", placeholder: "かな or romaji", "aria-label": "Your answer in kana",
      });
      const preview = h("p", { class: "kana-preview jp", lang: "ja", "aria-hidden": "true" });
      // checkAnswer already accepts romaji; the preview only shows the learner
      // what their romaji will be read as, so a typo is visible before submit.
      input.addEventListener("input", () => {
        const v = input!.value;
        preview.textContent = /[a-z]/i.test(v) ? `→ ${romajiToKana(v)}` : "";
      });
      body = h("form", { class: "produce", onsubmit: (e: Event) => {
        e.preventDefault();
        if (input!.value.trim()) submit(input!.value);
      } }, input, preview, h("button", { class: "btn primary", type: "submit" }, "Check"));
    }

    const stimulus = hasAudioStimulus(q)
      ? h("div", { class: "listen" },
          h("button", { class: "play", type: "button", "aria-label": "Play the audio again",
            onclick: () => void say(q.audioText!) }, "▶"),
          h("p", { class: "muted" }, "Listen, then choose. Tap ▶ to replay."))
      : q.prompt
        ? h("div", { class: "prompt" },
            h("p", { class: q.mode === "production" ? "prompt-en" : "prompt-jp jp", lang: q.mode === "production" ? "en" : "ja" }, q.prompt),
            q.promptReading ? h("p", { class: "jp-reading", lang: "ja" }, q.promptReading) : null)
        : null;

    mount(root,
      header(), audioNotice(waiting),
      h("section", { class: "card" }, badge(q), h("p", { class: "instruction" }, q.instruction), stimulus),
      body, feedback, actions);
    actions.append(dontKnow);
    // The keyboard should come up at once on a typed card; that IS the next action.
    input?.focus();

    // Keyboard shortcuts mirror the CLI prompt (1-4, ?), for desktop dev and
    // for phones with a hardware keyboard.
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (answered) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); next(); } return; }
      const n = Number(e.key);
      if (n >= 1 && n <= choiceButtons.length) submit(String(n - 1));
      else if (e.key === "?") submit(DONT_KNOW);
      else if (e.key === "r" && hasAudioStimulus(q)) void say(q.audioText);
    };
    document.addEventListener("keydown", onKey);
    disposers.push(() => document.removeEventListener("keydown", onKey));

    if (hasAudioStimulus(q)) {
      void say(q.audioText).then((ok) => {
        if (answered) return;
        if (ok) clock.restart();
        else unheardView(q);
      });
    }

    function showResult(q: Question, r: GradeResult, response: string): void {
      dontKnow.remove();
      for (const [i, b] of choiceButtons.entries()) {
        b.disabled = true;
        if (i === q.answerIndex) b.classList.add("right");
        else if (String(i) === response) b.classList.add("wrong");
      }
      if (input) { input.disabled = true; input.classList.add(r.correct ? "right" : "wrong"); }
      // Motion, touch and sound together, at the moment of grading. "I don't
      // know" is not an error, so it gets no shake and no buzz.
      const picked = input ?? choiceButtons[Number(response)];
      if (r.correct) { pop(picked); haptic(ctx.db, "confirm"); chime(ctx.db, true); }
      else if (response !== DONT_KNOW) {
        shake(picked); haptic(ctx.db, "reject");
        // After a miss with audio, the slow spoken replay below is the signal;
        // a tone on top of it would talk over the word.
        if (!(q.audioText && ctx.audio.ok)) chime(ctx.db, false);
      }
      const verdict = r.correct
        ? h("p", { class: "verdict ok" }, r.rating === 2 ? "Correct, but slow: rated Hard" : "Correct")
        : h("p", { class: "verdict bad" }, response === DONT_KNOW ? "Not yet: " : "Wrong: ",
            h("span", { lang: "ja", class: "jp" }, r.answer));
      mount(feedback, h("div", { class: `result ${r.correct ? "ok" : "bad"}` },
        verdict, revealBlock(r.reveal),
        h("p", { class: "muted" }, `Next review in ${r.intervalHuman}`)));
      enter(feedback.firstElementChild);
      // The verdict lands below the choices, often under the fold on a phone.
      // Bring it into view; Next stays reachable in the sticky action bar.
      feedback.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
      const nextBtn = h("button", { class: "btn primary big", type: "button", onclick: next }, "Next");
      const replay = q.audioText && ctx.audio.ok
        ? h("button", { class: "btn ghost", type: "button", onclick: () => void say(q.audioText!, RATE_SLOW) }, "Play")
        : null;
      mount(actions, replay, nextBtn);
      focusIfPointer(nextBtn);
      // cli.ts replays the word, slower, after a miss: hearing it at the moment
      // of correction is the cheapest repetition there is.
      if (!r.correct && q.audioText) void say(q.audioText, RATE_SLOW);
    }

    /** cli.ts unheardCard: an unheard card is shown, never graded. */
    function unheardView(q: Question): void {
      answered = true;
      mount(root,
        header(),
        h("section", { class: "card" }, badge(q),
          h("div", { class: "notice" },
            h("p", null, h("strong", null, "The audio did not play, "),
              "so this card was not graded. Answering it now would grade a guess."),
            h("button", { class: "link", type: "button", onclick: () => ctx.openVoiceSettings() },
              "Install Japanese voice data")),
          revealBlock(q.reveal)),
        h("div", { class: "actions sticky" },
          h("button", { class: "btn primary big", type: "button", onclick: next }, "Continue without listening")));
    }
  }

  next();
  return cleanup;
}

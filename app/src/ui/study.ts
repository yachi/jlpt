/**
 * Study: one card at a time, the same loop as cli.ts cmdStudy.
 *
 * Every decision about WHAT to ask and HOW it scores is a core call
 * (nextQuestion, introduceCard, grade); this file only measures the answer
 * time and draws. The one thing the app adds is pick.ts's rule that an
 * unplayable listening card is skipped rather than served silent.
 */
import { grade, hasAudioStimulus, introduceCard, humanInterval, dueCount, DONT_KNOW,
  type Question, type GradeResult } from "../../../src/quiz";
import { romajiToKana } from "../../../src/romaji";
import { h, mount, revealBlock } from "./dom";
import { getLevel, getMode, MODE_LABEL, type Ctx } from "./context";
import { pickQuestion, nothingDue } from "./pick";

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

  function header(): HTMLElement {
    const s = dueCount(ctx.db);
    return h("div", { class: "session" },
      h("span", null, asked ? `${right}/${asked} correct` : "Ready"),
      h("span", null, `${s.due} due · ${s.learned}/${s.total} introduced`));
  }

  function audioNotice(waiting: number): HTMLElement | null {
    if (ctx.audio.ok) return null;
    return h("div", { class: "notice" },
      h("p", null, h("strong", null, "No Japanese voice. "),
        "Listening cards are skipped, not served silent",
        waiting ? ` (${waiting} waiting).` : "."),
      h("button", { class: "link", type: "button", onclick: () => void ctx.platform.openTtsSettings() },
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
        h("p", { class: "muted" }, n.detail),
        asked ? h("p", { class: "summary" },
          `This session: ${right}/${asked} correct (${Math.round((right / asked) * 100)}%)`) : null),
      h("div", { class: "actions" },
        h("button", { class: "btn", type: "button", onclick: next }, "Check again")));
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
      ctx.toast(`First test in ${humanInterval(due - Date.now())}`);
      next();
    } }, "Got it");
    mount(root,
      header(), audioNotice(waiting),
      h("section", { class: "card" },
        badge(q),
        h("p", { class: "instruction" }, "New word: study it. It will be tested in about ten minutes."),
        revealBlock(q.reveal)),
      h("div", { class: "actions" }, play, got));
    focusIfPointer(got);
    if (q.audioText) void say(q.audioText);
  }

  // ------------------------------------------------------------- questions

  function questionView(q: Question, waiting: number): void {
    const clock = new AnswerClock();
    disposers.push(() => clock.dispose());
    let answered = false;
    const feedback = h("div", { class: "feedback", "aria-live": "polite" });
    const actions = h("div", { class: "actions" });
    const choiceButtons: HTMLButtonElement[] = [];
    const isJaChoice = q.mode === "reading";

    const submit = (response: string) => {
      if (answered) return;
      answered = true;
      const r = grade(ctx.db, q, response, clock.elapsed());
      ctx.save();
      asked++; if (r.correct) right++;
      root.querySelector(".session")?.replaceWith(header());
      showResult(q, r, response);
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
      const verdict = r.correct
        ? h("p", { class: "verdict ok" }, r.rating === 2 ? "Correct, but slow: rated Hard" : "Correct")
        : h("p", { class: "verdict bad" }, response === DONT_KNOW ? "Not yet: " : "Wrong: ",
            h("span", { lang: "ja", class: "jp" }, r.answer));
      mount(feedback, h("div", { class: `result ${r.correct ? "ok" : "bad"}` },
        verdict, revealBlock(r.reveal),
        h("p", { class: "muted" }, `Next review in ${r.intervalHuman}`)));
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
            h("button", { class: "link", type: "button", onclick: () => void ctx.platform.openTtsSettings() },
              "Install Japanese voice data")),
          revealBlock(q.reveal)),
        h("div", { class: "actions" },
          h("button", { class: "btn primary big", type: "button", onclick: next }, "Continue without listening")));
    }
  }

  next();
  return cleanup;
}

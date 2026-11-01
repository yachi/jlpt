/**
 * Mock exam, scored like cli.ts cmdExam against the real JLPT weighting:
 *   Language Knowledge + Reading 0-120, floor 38; Listening 0-60, floor 19;
 *   pass at 80 (N5) / 90 (N4), AND both floors cleared.
 * Answers never touch the scheduler: checkAnswer scores, grade() is not called.
 *
 * One deliberate difference from the CLI: question SELECTION. cmdExam calls
 * nextQuestion() in a loop without grading, and nextQuestion is read-only, so
 * it returns the same most-overdue card every time -- a 20-question sitting of
 * one word. Here each sitting samples distinct items of the level uniformly
 * and builds them with the core buildQuestion(), which is also closer to the
 * real exam: it draws from the whole level, not from what you have studied.
 */
import { buildQuestion, checkAnswer, hasAudioStimulus, DONT_KNOW, type Question } from "../../../src/quiz";
import type { Item } from "../../../src/bank";
import type { Mode } from "../../../src/schema";
import { h, mount } from "./dom";
import { getLevel, type Ctx } from "./context";

const K_FLOOR = 38, L_FLOOR = 19;
const PASS_MARK = { N5: 80, N4: 90 } as const;

export function examScreen(ctx: Ctx, root: HTMLElement): () => void {
  let alive = true;
  const pref = getLevel(ctx.db);
  let level: "N5" | "N4" = pref === "N4" ? "N4" : "N5";
  const nK = 20, nL = 10;

  function intro(): void {
    const seg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Level" },
      (["N5", "N4"] as const).map((lv) => h("button", {
        type: "button", role: "radio", "aria-checked": String(lv === level),
        class: lv === level ? "on" : "", onclick: () => { level = lv; intro(); },
      }, lv)));
    mount(root,
      h("h1", { class: "screen-title" }, "Mock exam"),
      h("section", { class: "card" },
        h("p", null, `${nK} knowledge + ${nL} listening questions. No feedback until the end.`),
        h("p", { class: "muted" }, `Scored against the real floors: knowledge ≥ ${K_FLOOR}/120, `
          + `listening ≥ ${L_FLOOR}/60, total ≥ ${PASS_MARK[level]}/180. It does not affect your review schedule.`),
        seg),
      ctx.audio.ok ? null : h("div", { class: "notice" },
        h("p", null, h("strong", null, "Needs a Japanese voice. "),
          "A listening section nobody could hear would record a fabricated score."),
        h("button", { class: "link", type: "button", onclick: () => ctx.openVoiceSettings() },
          "Install Japanese voice data")),
      h("div", { class: "actions" },
        h("button", { class: "btn primary big", type: "button", disabled: !ctx.audio.ok, onclick: run }, "Start")));
  }

  function sample(mode: Mode, n: number): Question[] {
    const items = ctx.db.query<Item, [string, number]>(
      "SELECT id, level, expression, reading, meaning, has_kanji FROM items WHERE level = ? ORDER BY random() LIMIT ?",
    ).all(level, n);
    return items.map((it) => buildQuestion(ctx.db, it, mode, false));
  }

  async function run(): Promise<void> {
    const sections: { mode: Mode; qs: Question[] }[] = [
      { mode: "meaning", qs: sample("meaning", nK) },
      { mode: "listening", qs: sample("listening", nL) },
    ];
    const right: Record<string, number> = { meaning: 0, listening: 0 };
    for (const sec of sections) {
      for (const [i, q] of sec.qs.entries()) {
        const response = await ask(q, sec.mode === "meaning" ? "Language knowledge" : "Listening", i, sec.qs.length);
        if (!alive) return;
        if (response === null) return abandoned();
        if (checkAnswer(q, response)) right[sec.mode]!++;
      }
    }
    // Score over the questions asked, as cmdExam does, so a short bank still
    // scales to the official 120/60 maxima.
    const kScore = Math.round((right.meaning! / Math.max(1, sections[0]!.qs.length)) * 120);
    const lScore = Math.round((right.listening! / Math.max(1, sections[1]!.qs.length)) * 60);
    ctx.db.query(
      "INSERT INTO exams (level, ts, knowledge_score, knowledge_max, listening_score, listening_max) VALUES (?,?,?,?,?,?)",
    ).run(level, Date.now(), kScore, 120, lScore, 60);
    ctx.save();
    result(kScore, lScore);
  }

  /** Resolves with the response, or null when the audio could not be played. */
  function ask(q: Question, section: string, i: number, n: number): Promise<string | null> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: string | null) => { if (!done) { done = true; resolve(v); } };
      mount(root,
        h("div", { class: "session" }, h("span", null, `${level} · ${section}`), h("span", null, `${i + 1} / ${n}`)),
        h("div", { class: "progress" }, h("div", { style: `width:${(i / n) * 100}%` })),
        h("section", { class: "card" },
          h("p", { class: "instruction" }, q.instruction),
          hasAudioStimulus(q)
            // No replay: the real listening section plays each item once.
            ? h("div", { class: "listen" }, h("p", { class: "muted" }, "Listen."))
            : h("div", { class: "prompt" }, h("p", { class: "prompt-jp jp", lang: "ja" }, q.prompt),
                q.promptReading ? h("p", { class: "jp-reading", lang: "ja" }, q.promptReading) : null)),
        h("div", { class: "choices" }, q.choices.map((c, j) =>
          h("button", { class: "choice", type: "button", onclick: () => finish(String(j)) },
            h("span", { class: "choice-n" }, String(j + 1)), h("span", { class: "choice-t" }, c)))),
        h("div", { class: "actions" },
          h("button", { class: "btn ghost", type: "button", onclick: () => finish(DONT_KNOW) }, "I don't know")));
      if (hasAudioStimulus(q)) {
        void ctx.platform.speak(q.audioText, { rate: 0.9 }).catch(() => false).then((ok) => {
          if (!ok) { ctx.audio.ok = false; finish(null); }
        });
      }
    });
  }

  function abandoned(): void {
    mount(root,
      h("h1", { class: "screen-title" }, "Exam abandoned"),
      h("section", { class: "card" },
        h("p", null, "The audio did not play, so nothing was recorded. A silent listening section would put a "
          + "fabricated score into the history the next sitting is compared against.")),
      h("div", { class: "actions" },
        h("button", { class: "btn", type: "button", onclick: () => ctx.openVoiceSettings() }, "Voice settings"),
        h("button", { class: "btn primary", type: "button", onclick: intro }, "Back")));
  }

  function result(k: number, l: number): void {
    const total = k + l, pass = PASS_MARK[level];
    const kOk = k >= K_FLOOR, lOk = l >= L_FLOOR, tOk = total >= pass;
    const passed = kOk && lOk && tOk;
    const row = (label: string, score: string, need: string, ok: boolean) =>
      h("tr", null, h("td", null, label), h("td", { class: "num" }, score), h("td", { class: "num muted" }, need),
        h("td", null, h("span", { class: `badge ${ok ? "pass" : "fail"}` }, ok ? "PASS" : "FAIL")));
    mount(root,
      h("h1", { class: "screen-title" }, `${level} mock result`),
      h("section", { class: `card verdict-card ${passed ? "ok" : "bad"}` },
        h("p", { class: "big-verdict" }, passed ? "PASS" : "FAIL"),
        h("table", { class: "mix" }, h("tbody", null,
          row("Knowledge + Reading", `${k}/120`, `≥ ${K_FLOOR}`, kOk),
          row("Listening", `${l}/60`, `≥ ${L_FLOOR}`, lOk),
          row("Total", `${total}/180`, `≥ ${pass}`, tOk))),
        !passed && tOk ? h("p", { class: "warn-text" },
          "Total cleared but a section floor failed: this is how most N4 candidates fail.") : null),
      h("p", { class: "muted small" }, "Estimates only. Calibrate against the free official workbooks at jlpt.jp."),
      h("div", { class: "actions" }, h("button", { class: "btn primary", type: "button", onclick: intro }, "Done")));
  }

  intro();
  return () => { alive = false; };
}

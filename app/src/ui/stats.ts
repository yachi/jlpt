/**
 * Stats: the numbers cli.ts cmdStats prints, as a phone screen. Same queries,
 * so the two can be compared on one study.db.
 */
import { dueCount, introducedByMode, modePriority, parseModeWeights } from "../../../src/quiz";
import { getSetting, MODES, type Mode } from "../../../src/schema";
import { h, mount } from "./dom";
import { MODE_LABEL, type Ctx } from "./context";

/**
 * Fewest reviews before a mode can be called the weakest. One miss in two
 * tries is 50% and would outrank a real 70% over three hundred; below this the
 * percentage is noise, not a weakness.
 */
const WEAKEST_MIN_REVIEWS = 10;

export function statsScreen(ctx: Ctx, root: HTMLElement): () => void {
  const { db } = ctx;
  const now = Date.now();
  const s = dueCount(db, now);
  const reviews = db.query<{ mode: Mode; n: number; correct: number }, []>(
    "SELECT mode, COUNT(*) AS n, SUM(correct) AS correct FROM reviews GROUP BY mode").all();
  const last7 = db.query<{ n: number; correct: number }, [number]>(
    "SELECT COUNT(*) AS n, COALESCE(SUM(correct),0) AS correct FROM reviews WHERE ts > ?").get(now - 7 * 86_400_000)!;
  const mature = db.query<{ mode: Mode; n: number }, []>(
    "SELECT mode, COUNT(*) AS n FROM cards WHERE introduced = 1 AND stability >= 21 GROUP BY mode").all();
  const totals = db.query<{ mode: Mode; n: number }, []>(
    "SELECT mode, COUNT(*) AS n FROM cards GROUP BY mode").all();
  const introduced = introducedByMode(db);
  const byMode = (rows: { mode: Mode; n: number }[], m: Mode) => rows.find((r) => r.mode === m)?.n ?? 0;
  const acc = (m: Mode) => {
    const r = reviews.find((x) => x.mode === m);
    return r && r.n ? { n: r.n, pct: Math.round((r.correct / r.n) * 100) } : { n: 0, pct: 0 };
  };
  const ranked = MODES.filter((m) => acc(m).n >= WEAKEST_MIN_REVIEWS).sort((a, b) => acc(a).pct - acc(b).pct);
  const weakest = ranked.length >= 2 ? ranked[0]! : null;
  const matureTotal = mature.reduce((a, r) => a + r.n, 0);

  const tile = (label: string, value: string, sub?: string) =>
    h("div", { class: "tile" }, h("div", { class: "tile-v" }, value), h("div", { class: "tile-l" }, label),
      sub ? h("div", { class: "tile-s" }, sub) : null);

  const modeRows = MODES.map((m) => {
    const total = byMode(totals, m) || 1;
    const a = acc(m);
    const intro = introduced[m];
    return h("div", { class: `mode-row${m === weakest ? " weakest" : ""}` },
      h("div", { class: "mode-head" },
        h("span", { class: "mode-name" }, MODE_LABEL[m]),
        m === weakest ? h("span", { class: "badge warn" }, "weakest") : null,
        h("span", { class: "muted" }, a.n ? `${a.pct}% of ${a.n}` : "no reviews")),
      h("div", { class: "bar", role: "img", "aria-label": `${intro} of ${total} introduced, ${byMode(mature, m)} mature` },
        h("div", { class: "bar-intro", style: `width:${(intro / total) * 100}%` }),
        h("div", { class: "bar-mature", style: `width:${(byMode(mature, m) / total) * 100}%` })),
      h("div", { class: "mode-foot muted" },
        `${intro}/${byMode(totals, m)} introduced · ${byMode(mature, m)} mature`),
      // The CLI's warning, verbatim in spirit: listening is the usual N4 failure.
      m === "listening" && a.n && a.pct < 60
        ? h("p", { class: "warn-text" }, "Listening under 60%: the listening floor is the usual way N4 is failed.")
        : null);
  });

  const weights = parseModeWeights(getSetting(db, "mode_weights", ""));
  const introTotal = MODES.reduce((a, m) => a + introduced[m], 0);
  const wSum = MODES.reduce((a, m) => a + weights[m], 0) || 1;
  const mix = introTotal ? modePriority(introduced, weights).map((m) => {
    const actual = (introduced[m] / introTotal) * 100;
    const target = (weights[m] / wSum) * 100;
    return h("tr", null, h("td", null, MODE_LABEL[m]),
      h("td", { class: "num" }, `${actual.toFixed(0)}%`), h("td", { class: "num" }, `${target.toFixed(0)}%`),
      h("td", null, actual - target < -10 ? h("span", { class: "badge" }, "next up") : null));
  }) : [];

  const exams = db.query<{ ts: number; level: string; knowledge_score: number; listening_score: number }, []>(
    "SELECT ts, level, knowledge_score, listening_score FROM exams ORDER BY ts DESC LIMIT 5").all();

  mount(root,
    h("h1", { class: "screen-title" }, "Progress"),
    h("div", { class: "tiles" },
      tile("due now", String(s.due)),
      tile("introduced", `${s.learned}`, `of ${s.total} cards`),
      tile("mature", String(matureTotal), "stability ≥ 21d"),
      tile("last 7 days", String(last7.n), last7.n ? `${Math.round((last7.correct / last7.n) * 100)}% correct` : "reviews")),
    h("h2", null, "By mode"),
    h("section", { class: "card" }, modeRows,
      h("p", { class: "legend muted" },
        h("span", { class: "sw sw-intro" }), "introduced ", h("span", { class: "sw sw-mature" }), "mature")),
    introTotal ? [h("h2", null, "New-card mix vs target"),
      h("section", { class: "card" }, h("table", { class: "mix" },
        h("thead", null, h("tr", null, h("th", null, "Mode"), h("th", { class: "num" }, "Actual"),
          h("th", { class: "num" }, "Target"), h("th", null, ""))),
        h("tbody", null, mix)))] : null,
    exams.length ? [h("h2", null, "Recent mock exams"),
      h("section", { class: "card" }, exams.map((e) => h("div", { class: "exam-row" },
        h("span", null, new Date(e.ts).toLocaleDateString()),
        h("span", null, e.level),
        h("span", { class: "num" }, `${e.knowledge_score + e.listening_score}/180`),
        h("span", { class: "muted" }, `K ${e.knowledge_score} · L ${e.listening_score}`))))] : null);
  return () => {};
}

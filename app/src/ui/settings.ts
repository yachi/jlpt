/**
 * Settings. The study keys are the CLI's own (`cli set <key> <value>`), so a
 * study.db carried between phone and desktop keeps its behaviour:
 *   new_per_day, teach_new_first, skip_meaning_for_kanji, mode_weights.
 * Only the level/mode filter is app-only (see context.ts APP_LEVEL_KEY).
 */
import { getSetting, setSetting, MODES, type Mode } from "../../../src/schema";
import { parseModeWeights } from "../../../src/quiz";
import { APP_HAPTICS_KEY, APP_SOUND_KEY, APP_STREAK_KEY } from "./fx";
import { h, mount } from "./dom";
import { deliverBackup } from "../platform/share-backup";
import { getLevel, getMode, setFilter, MODE_LABEL, type Ctx, type Level } from "./context";

export function settingsScreen(ctx: Ctx, root: HTMLElement): () => void {
  const { db } = ctx;
  let alive = true;

  const set = (k: string, v: string) => { setSetting(db, k, v); ctx.save(); };

  function seg<T extends string>(label: string, options: readonly T[], current: T,
    name: (v: T) => string, pick: (v: T) => void): HTMLElement {
    return h("div", { class: "field" },
      h("span", { class: "field-l" }, label),
      h("div", { class: "seg", role: "radiogroup", "aria-label": label }, options.map((v) =>
        h("button", { type: "button", role: "radio", "aria-checked": String(v === current),
          class: v === current ? "on" : "", onclick: () => { pick(v); render(); } }, name(v)))));
  }

  function toggle(label: string, help: string, key: string, dflt: "0" | "1"): HTMLElement {
    const id = `t-${key}`;
    const box = h("input", { id, type: "checkbox", class: "switch", role: "switch" });
    box.checked = getSetting(db, key, dflt) === "1";
    box.addEventListener("change", () => set(key, box.checked ? "1" : "0"));
    return h("div", { class: "field row" },
      h("label", { for: id }, h("span", { class: "field-l" }, label), h("span", { class: "help" }, help)),
      box);
  }

  function newPerDay(): HTMLElement {
    let n = Number.parseInt(getSetting(db, "new_per_day", "5"), 10);
    if (!Number.isFinite(n) || n < 0) n = 5;
    const out = h("output", { class: "num big-num", "aria-live": "polite" }, String(n));
    const step = (d: number) => { n = Math.max(0, Math.min(100, n + d)); out.textContent = String(n); set("new_per_day", String(n)); };
    return h("div", { class: "field row" },
      h("div", null, h("span", { class: "field-l" }, "New words per day"),
        h("span", { class: "help" }, "Each word is taught first, then tested about ten minutes later.")),
      h("div", { class: "stepper" },
        h("button", { type: "button", class: "btn ghost", "aria-label": "Fewer", onclick: () => step(-1) }, "−"),
        out,
        h("button", { type: "button", class: "btn ghost", "aria-label": "More", onclick: () => step(1) }, "+")));
  }

  function weights(): HTMLElement {
    const w = parseModeWeights(getSetting(db, "mode_weights", ""));
    const inputs = MODES.map((m) => {
      const i = h("input", { type: "number", inputmode: "numeric", min: "0", max: "100", value: String(w[m]),
        "aria-label": `${MODE_LABEL[m]} weight` });
      i.addEventListener("change", () => {
        // Written in the CLI's own spec format, so parseModeWeights reads it
        // back identically on either side.
        const spec = MODES.map((mm, j) => `${mm}:${Math.max(0, Number(inputs[j]!.value) || 0)}`).join(",");
        set("mode_weights", spec);
      });
      return i;
    });
    return h("div", { class: "field" },
      h("span", { class: "field-l" }, "New-card mix"),
      h("span", { class: "help" }, "Relative share of new cards per mode. A mode that falls behind is introduced first."),
      h("div", { class: "weights" }, MODES.map((m, j) => h("label", null, h("span", null, MODE_LABEL[m]), inputs[j]!))));
  }

  const voice = h("div", { class: "field" });
  async function renderVoice(): Promise<void> {
    const ok = await ctx.platform.canSpeak().catch(() => false);
    const why = await ctx.platform.voiceStatus().catch(() => null);
    if (!alive) return;
    // A voice installed while the app was open should bring listening back
    // without a restart; Ctx.audio is otherwise only ever lowered.
    if (ok) ctx.audio.ok = true;
    mount(voice,
      h("span", { class: "field-l" }, "Japanese voice"),
      h("span", { class: "help" }, ok ? "Available. Listening cards and the mock exam are on."
        : "Not found. Listening cards are skipped until Google's Japanese voice data is installed."),
      why ? h("span", { class: "help", "data-testid": "voice-status" }, why) : null,
      h("div", { class: "btn-row" },
        h("button", { type: "button", class: "btn", onclick: async () => {
          const played = await ctx.platform.speak("こんにちは。日本語の勉強を始めましょう。").catch(() => false);
          ctx.audio.ok = played;
          ctx.toast(played ? "Voice works" : "No Japanese voice played", played ? "info" : "error");
          void renderVoice();
        } }, "Test voice"),
        h("button", { type: "button", class: "btn ghost", onclick: () => ctx.openVoiceSettings() },
          "Open voice settings")));
  }

  function backup(): HTMLElement {
    const file = h("input", { type: "file", accept: ".db,.sqlite,application/octet-stream,application/x-sqlite3", hidden: true });
    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      file.value = "";
      if (!f) return;
      if (!confirm(`Replace ALL progress on this phone with "${f.name}"? This cannot be undone.`)) return;
      try {
        await ctx.platform.importBackup(new Uint8Array(await f.arrayBuffer()));
        // Reload rather than patch up: every screen and the gloss cache in
        // bank.ts hold onto the old database, and importBackup already seeded the app lists into it.
        location.reload();
      } catch (e) {
        ctx.toast(`Import failed, nothing changed: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    });
    return h("div", { class: "field" },
      h("span", { class: "field-l" }, "Backup"),
      h("span", { class: "help" }, "A study.db file. The desktop CLI opens the same file."),
      h("div", { class: "btn-row" },
        h("button", { type: "button", class: "btn", onclick: async () => {
          try {
            const bytes = await ctx.platform.exportBackup();
            await deliverBackup(bytes, `jlpt-study-${new Date().toISOString().slice(0, 10)}.db`);
          } catch (e) {
            ctx.toast(`Export failed: ${e instanceof Error ? e.message : String(e)}`, "error");
          }
        } }, "Export"),
        h("button", { type: "button", class: "btn ghost", onclick: () => file.click() }, "Import…"), file));
  }

  function render(): void {
    const level = getLevel(db), mode = getMode(db);
    mount(root,
      h("h1", { class: "screen-title" }, "Settings"),
      h("h2", null, "What to study"),
      h("section", { class: "card" },
        seg<Level>("Level", ["both", "N5", "N4"], level, (v) => v === "both" ? "Both" : v,
          (v) => { setFilter(db, v, mode); ctx.save(); }),
        seg<Mode | "any">("Mode", ["any", ...MODES], mode, (v) => v === "any" ? "All" : MODE_LABEL[v],
          (v) => { setFilter(db, level, v); ctx.save(); })),
      h("h2", null, "New words"),
      h("section", { class: "card" },
        newPerDay(),
        toggle("Teach new words first", "Show a new word with its reading and meaning before asking it.",
          "teach_new_first", "1"),
        toggle("Skip meaning cards for kanji", "For a kanji background: 秋 is a free point. False friends are still asked.",
          "skip_meaning_for_kanji", "0"),
        weights()),
      h("h2", null, "Feedback"),
      h("section", { class: "card" },
        toggle("Show streak", "Days in a row you studied. A missed day is covered by a streak freeze.",
          APP_STREAK_KEY, "1"),
        toggle("Sounds", "A soft tone when you answer. Never plays over a spoken word.", APP_SOUND_KEY, "1"),
        toggle("Vibration", "A short tick when you answer. Follows the phone's touch feedback setting.",
          APP_HAPTICS_KEY, "1")),
      h("h2", null, "Audio"),
      h("section", { class: "card" }, voice),
      h("h2", null, "Data"),
      h("section", { class: "card" }, backup()),
      h("p", { class: "muted small about" },
        "Word lists: open-anki-jlpt-decks (MIT), from the tanos.co.uk lists, which reconstruct the withdrawn "
        + "2004 JLPT 出題基準. Unofficial by construction: JLPT has published no syllabus since 2010."));
    void renderVoice();
  }

  render();
  return () => { alive = false; };
}

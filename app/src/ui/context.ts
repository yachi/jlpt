/**
 * What every screen gets: the platform, a fire-and-forget save, and the
 * session's view of whether Japanese audio works.
 */
import type { Platform } from "../platform/types";
import type { Db } from "../../../src/sqlite";
import { getSetting, setSetting, MODES, type Mode } from "../../../src/schema";
import { h } from "./dom";

export type Level = "N5" | "N4" | "both";

/**
 * App-only settings keys. The CLI takes level/mode as per-run flags, not
 * settings; a phone has no command line, so the app keeps the filter in the
 * same settings table under an `app_` prefix that the CLI never reads.
 */
export const APP_LEVEL_KEY = "app_level";
export const APP_MODE_KEY = "app_mode";

export interface Ctx {
  platform: Platform;
  db: Db;
  /**
   * Whether a listening card can be heard. Starts from canSpeak() and drops to
   * false for the rest of the session the first time speak() fails -- the CLI
   * stops its study loop for the same reason: whatever silenced one card
   * silences the next, and serving them anyway would grade guesses.
   */
  audio: { ok: boolean };
  /** Persist shortly, in the background; failures surface as a toast. */
  save(): void;
  toast(msg: string, kind?: "info" | "error"): void;
}

export function makeCtx(platform: Platform, audioOk: boolean): Ctx {
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const ctx: Ctx = {
    platform, db: platform.db, audio: { ok: audioOk },
    // Debounced, not immediate: flush() exports the whole database
    // synchronously, so flushing inside the tap handler would delay the
    // feedback paint by the export time, which grows with the review log
    // (a few ms now, tens of ms after a year). The writes have already
    // marked the store dirty, the pause listener flushes on backgrounding,
    // and this timer only adds a save whose failure reaches the learner.
    save() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        platform.save().catch((e: unknown) =>
          ctx.toast(`Could not save progress: ${e instanceof Error ? e.message : String(e)}`, "error"));
      }, 400);
    },
    toast,
  };
  return ctx;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string, kind: "info" | "error" = "info"): void {
  document.querySelector(".toast")?.remove();
  const el = h("div", { class: `toast ${kind}`, role: kind === "error" ? "alert" : "status" }, msg);
  document.body.append(el);
  clearTimeout(toastTimer);
  // Errors stay longer: a failed save is the one thing the learner must see.
  toastTimer = setTimeout(() => el.remove(), kind === "error" ? 8000 : 2500);
}

export function getLevel(db: Db): Level {
  const v = getSetting(db, APP_LEVEL_KEY, "both");
  return v === "N5" || v === "N4" ? v : "both";
}
export function getMode(db: Db): Mode | "any" {
  const v = getSetting(db, APP_MODE_KEY, "any");
  return (MODES as readonly string[]).includes(v) ? (v as Mode) : "any";
}
export function setFilter(db: Db, level: Level, mode: Mode | "any"): void {
  setSetting(db, APP_LEVEL_KEY, level);
  setSetting(db, APP_MODE_KEY, mode);
}

export const MODE_LABEL: Record<Mode, string> = {
  meaning: "Meaning", reading: "Reading", listening: "Listening", production: "Production",
};

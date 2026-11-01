/**
 * Feedback the learner sees, feels and hears at the moment of answering.
 *
 * Kept small and one-shot on purpose: touch feedback improves perceived
 * performance, but learners need less of it with experience (Hoggan et al.,
 * CHI 2008/2009), and Android's guidance is "no haptics beats buzzy haptics".
 * None of it is the only signal: the verdict text, its colour and the
 * aria-live region still say right or wrong on their own.
 *
 * Timing follows Material 3 motion: ~200 ms for a small change, 300 ms for a
 * shake, transform/opacity only so the WebView never re-lays out.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";
import { getSetting } from "../../../src/schema";
import type { Db } from "../../../src/sqlite";

export const APP_SOUND_KEY = "app_sound";
export const APP_HAPTICS_KEY = "app_haptics";
export const APP_STREAK_KEY = "app_streak";

export function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Material 3 "expressive fast spatial": a small overshoot, then settle. */
const POP_EASE = "cubic-bezier(0.42, 1.67, 0.21, 0.90)";

export function pop(el: Element | null | undefined): void {
  if (!el || reducedMotion() || !("animate" in el)) return;
  el.animate([{ transform: "scale(1)" }, { transform: "scale(1.04)" }, { transform: "scale(1)" }],
    { duration: 240, easing: POP_EASE });
}

export function shake(el: Element | null | undefined): void {
  if (!el || reducedMotion() || !("animate" in el)) return;
  el.animate([
    { transform: "translateX(0)" }, { transform: "translateX(-6px)" }, { transform: "translateX(6px)" },
    { transform: "translateX(-4px)" }, { transform: "translateX(4px)" }, { transform: "translateX(0)" },
  ], { duration: 300, easing: "ease-out" });
}

/** Fade and lift in, for the verdict box and the done screen. */
export function enter(el: Element | null | undefined, delay = 0): void {
  if (!el || reducedMotion() || !("animate" in el)) return;
  el.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }],
    { duration: 220, delay, easing: "cubic-bezier(0.05, 0.7, 0.1, 1)", fill: "backwards" });
}

/** Count a number up from 0 with ease-out; `fmt` draws each frame. */
export function countUp(el: HTMLElement, to: number, fmt: (n: number) => string = String, ms = 700): void {
  if (reducedMotion() || to <= 0) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const step = (t: number) => {
    const p = Math.min(1, (t - t0) / ms);
    el.textContent = fmt(Math.round(to * (1 - (1 - p) ** 3)));
    if (p < 1 && el.isConnected) requestAnimationFrame(step);
  };
  el.textContent = fmt(0);
  requestAnimationFrame(step);
}

/** Confetti, loaded only when earned so it costs nothing at startup. */
export async function celebrate(): Promise<void> {
  if (reducedMotion()) return;
  const { default: confetti } = await import("canvas-confetti");
  await confetti({ particleCount: 90, spread: 70, startVelocity: 38, origin: { y: 0.35 },
    disableForReducedMotion: true, colors: ["#b3261e", "#e8a33d", "#1b7a3d", "#ffffff"] });
}

// ------------------------------------------------------------------ haptics

/**
 * Local plugin, android/app/src/main/java/io/github/yachi/jlpt/FeedbackPlugin.java:
 * View.performHapticFeedback, which needs no VIBRATE permission and follows
 * the phone's own "touch feedback" setting. Not @capacitor/haptics, which
 * plays raw vibrator waveforms and ignores that setting.
 */
const Feedback = registerPlugin<{ haptic(o: { kind: Haptic }): Promise<void> }>("Feedback");
export type Haptic = "confirm" | "reject" | "tick";

export function haptic(db: Db, kind: Haptic): void {
  if (getSetting(db, APP_HAPTICS_KEY, "1") !== "1" || !Capacitor.isNativePlatform()) return;
  Feedback.haptic({ kind }).catch(() => { /* an old build without the plugin: stay silent */ });
}

// -------------------------------------------------------------------- sound

/**
 * Synthesised tones, no audio files: two soft rising notes for right, one low
 * soft note for wrong. Quiet (peak gain 0.12) and short (< 200 ms), so they
 * finish before any spoken replay starts.
 */
let audio: AudioContext | null = null;
let idle: ReturnType<typeof setTimeout> | undefined;

function note(ac: AudioContext, freq: number, at: number, len: number, type: OscillatorType): void {
  const osc = ac.createOscillator(), gain = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.12, at + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + len);
  osc.connect(gain).connect(ac.destination);
  osc.start(at);
  osc.stop(at + len + 0.02);
}

export function chime(db: Db, ok: boolean): void {
  if (getSetting(db, APP_SOUND_KEY, "1") !== "1") return;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  try {
    audio ??= new AC();
    const ac = audio;
    void ac.resume();
    const t = ac.currentTime + 0.01;
    if (ok) { note(ac, 659.25, t, 0.09, "sine"); note(ac, 830.61, t + 0.08, 0.12, "sine"); }
    else note(ac, 196, t, 0.16, "triangle");
    // A running AudioContext keeps the audio output open; let it sleep.
    clearTimeout(idle);
    idle = setTimeout(() => void ac.suspend(), 1500);
  } catch { /* no audio output: the text verdict is still there */ }
}

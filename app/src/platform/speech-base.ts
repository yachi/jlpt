/**
 * The voice half of the platform, without Capacitor imports, so open.ts and
 * app/test can depend on it in Node.
 */
import type { SpeakOptions } from "./types";

export interface Speech {
  speak(text: string, opts?: SpeakOptions): Promise<boolean>;
  canSpeak(): Promise<boolean>;
  /** Opens the phone's TTS settings. Rejects when no screen could be opened, so the UI can say so. */
  openSettings(): Promise<void>;
  /** One line on why Japanese is or is not available (engine, data state), or null when unknown. */
  describe(): Promise<string | null>;
}

/** For tests and for a device with TTS disabled entirely. */
export const silentSpeech: Speech = {
  async canSpeak() { return false; },
  async speak() { return false; },
  async openSettings() {},
  async describe() { return null; },
};

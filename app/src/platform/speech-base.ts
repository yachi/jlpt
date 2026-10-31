/**
 * The voice half of the platform, without Capacitor imports, so open.ts and
 * app/test can depend on it in Node.
 */
import type { SpeakOptions } from "./types";

export interface Speech {
  speak(text: string, opts?: SpeakOptions): Promise<boolean>;
  canSpeak(): Promise<boolean>;
  openSettings(): Promise<void>;
}

/** For tests and for a device with TTS disabled entirely. */
export const silentSpeech: Speech = {
  async canSpeak() { return false; },
  async speak() { return false; },
  async openSettings() {},
};

/**
 * Which Japanese voices to use, and in what order. Pure, so app/test covers it.
 *
 * The CLI rotates speakers on purpose (pickVoices in tts.ts): a learner who only
 * ever hears one voice learns that voice, and the JLPT listening section uses
 * several. So consecutive cards cycle through every installed ja voice.
 */

export interface VoiceInfo {
  /** Position in the list the engine reported; the native plugin selects by it. */
  index: number;
  name: string;
  lang: string;
  /** false = needs the network, which this app must not depend on. */
  localService: boolean;
}

/** BCP-47 "ja", "ja-JP", Android's "ja_JP" or "jpn"; never "jv" (Javanese). */
export function isJapanese(lang: string): boolean {
  return /^(ja|jpn)([-_]|$)/i.test(lang.trim());
}

/**
 * The Japanese voices to rotate over. Offline ones only, unless there are
 * none: a network voice silently fails on a phone with no signal, which would
 * turn into "not heard" on every listening card, but it beats no voice at all.
 */
export function japaneseVoices(all: readonly Omit<VoiceInfo, "index">[]): VoiceInfo[] {
  const ja = all.map((v, index) => ({ ...v, index })).filter((v) => isJapanese(v.lang));
  const local = ja.filter((v) => v.localService);
  // Sorted by name so the rotation order is stable across launches, whatever
  // order the engine enumerates in (the indices still point at the original list).
  return (local.length > 0 ? local : ja).sort((a, b) => a.name.localeCompare(b.name));
}

/** Round-robin over a voice list; `next()` is null when there are none. */
export class VoiceRotation {
  private i = 0;
  constructor(private voices: VoiceInfo[]) {}
  get size(): number { return this.voices.length; }
  next(): VoiceInfo | null {
    if (this.voices.length === 0) return null;
    const v = this.voices[this.i % this.voices.length]!;
    this.i = (this.i + 1) % this.voices.length;
    return v;
  }
}

/**
 * How long to wait for an utterance before calling it not heard. Engines do
 * wedge (the CLI's CoreAudio case; Android TTS while another app holds audio
 * focus), and a promise that never settles would freeze the study screen.
 * Generous: a slow 0.9-rate Japanese voice manages ~6 morae/s.
 */
export function speakTimeoutMs(text: string, rate = 1): number {
  return 5000 + Math.ceil((text.length * 400) / Math.max(rate, 0.1));
}

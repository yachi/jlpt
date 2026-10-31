/**
 * Japanese text-to-speech: the Android engine on device, Web Speech in a
 * desktop browser. Both honour the Platform contract that `false` means "not
 * heard": the UI must then show the reading and NOT grade a listening card,
 * exactly like the CLI's unheardCard().
 */
import { TextToSpeech } from "@capacitor-community/text-to-speech";
import type { Speech } from "./speech-base";
import type { SpeakOptions } from "./types";
export type { Speech } from "./speech-base";
import { japaneseVoices, speakTimeoutMs, VoiceRotation, type VoiceInfo } from "./voices";


const DEFAULT_LANG = "ja-JP";
/** The CLI plays at -10%; same here so the two feel alike. */
const DEFAULT_RATE = 0.9;

/** Resolve false instead of hanging when an engine never reports the end. */
function withTimeout(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    p.then(() => { clearTimeout(t); resolve(true); }, () => { clearTimeout(t); resolve(false); });
  });
}

/**
 * Android, via @capacitor-community/text-to-speech. Its `voice` option is an
 * index into getSupportedVoices(), which the plugin sorts by name, so the
 * indices we keep are stable until the user installs/removes voice data --
 * hence the voice list is re-read on each canSpeak() (the settings screen and
 * study start call it), not cached forever.
 */
export function nativeSpeech(): Speech {
  let rotation: Promise<VoiceRotation> | null = null;
  const load = (): Promise<VoiceRotation> => (rotation ??= (async () => {
    try {
      const { voices } = await TextToSpeech.getSupportedVoices();
      return new VoiceRotation(japaneseVoices(voices));
    } catch {
      return new VoiceRotation([]);
    }
  })());

  /** No ja voice listed, but the engine may still have the language (some OEM engines list no voices). */
  const langSupported = async (lang: string) => {
    try { return (await TextToSpeech.isLanguageSupported({ lang })).supported; } catch { return false; }
  };

  return {
    async canSpeak() {
      rotation = null;
      return (await load()).size > 0 || (await langSupported(DEFAULT_LANG));
    },
    async speak(text, opts = {}) {
      const lang = opts.lang ?? DEFAULT_LANG;
      const rate = opts.rate ?? DEFAULT_RATE;
      const voice: VoiceInfo | null = (await load()).next();
      if (!voice && !(await langSupported(lang))) return false;
      // speak() resolves on the engine's onDone, i.e. after playback ends.
      return withTimeout(
        TextToSpeech.speak({ text, lang, rate, ...(voice ? { voice: voice.index } : {}) }),
        speakTimeoutMs(text, rate));
    },
    async openSettings() {
      // ACTION_INSTALL_TTS_DATA: the engine's own voice-data screen, where the
      // Japanese pack is downloaded once and then works offline.
      await TextToSpeech.openInstall().catch(() => {});
    },
  };
}

/** Desktop browser (`vite dev`): window.speechSynthesis with a ja voice. */
export function webSpeech(): Speech {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  let rotation: VoiceRotation | null = null;
  let voices: SpeechSynthesisVoice[] = [];

  // Chrome fills getVoices() asynchronously; it is [] on the first call.
  const ready = async (): Promise<VoiceRotation> => {
    if (!synth) return new VoiceRotation([]);
    voices = synth.getVoices();
    if (voices.length === 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 1500);
        synth.addEventListener("voiceschanged", () => { clearTimeout(t); resolve(); }, { once: true });
      });
      voices = synth.getVoices();
    }
    rotation = new VoiceRotation(japaneseVoices(voices));
    return rotation;
  };

  return {
    async canSpeak() { return (await ready()).size > 0; },
    async speak(text, opts = {}) {
      if (!synth) return false;
      const v = (rotation ?? (await ready())).next();
      // No ja voice: a browser would read the kana with an English voice, or
      // say nothing. Either way the learner did not hear Japanese.
      if (!v) return false;
      const u = new SpeechSynthesisUtterance(text);
      u.voice = voices[v.index] ?? null;
      u.lang = opts.lang ?? DEFAULT_LANG;
      u.rate = opts.rate ?? DEFAULT_RATE;
      synth.cancel(); // a queued earlier card must not play over this one
      const done = new Promise<void>((resolve, reject) => {
        u.onend = () => resolve();
        u.onerror = (e) => reject(e);
      });
      synth.speak(u);
      return withTimeout(done, speakTimeoutMs(text, u.rate));
    },
    async openSettings() { /* no browser API for this */ },
  };
}

/**
 * Japanese text-to-speech with a disk cache.
 *
 * Provider order:
 *   1. Azure AI Speech (neural, ja-JP) when AZURE_SPEECH_KEY + AZURE_SPEECH_REGION are set
 *   2. macOS `say` fallback (offline, zero-config, lower quality), rotating over
 *      the installed ja_JP voices — see MACOS_JA_VOICES below
 *
 * Azure Free (F0) tier constraints enforced here (re-verified 2026-08-23):
 *   - 0.5M neural characters/month  -> tracked in data/tts-usage.json, hard-stops at the cap
 *     azure.microsoft.com/pricing/details/cognitive-services/speech-services
 *   - 20 TTS transactions / 60 s    -> client-side token bucket, not adjustable on F0
 *     learn.microsoft.com/azure/ai-services/speech-service/speech-services-quotas-and-limits
 *   - batch synthesis unavailable   -> we use the real-time /cognitiveservices/v1 endpoint
 * Every clip is cached on disk, so a given sentence costs characters exactly once.
 */
import { mkdirSync, existsSync, statSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./db";

const AUDIO_DIR = join(ROOT, "audio");
const USAGE_PATH = join(ROOT, "data", "tts-usage.json");

export const F0_MONTHLY_CHARS = 500_000;
const F0_MAX_REQUESTS_PER_WINDOW = 20;
const F0_WINDOW_MS = 60_000;

export interface TtsUsage { month: string; chars: number; requests: number }

function currentMonth(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 7); // YYYY-MM
}

export async function readUsage(now = Date.now()): Promise<TtsUsage> {
  const month = currentMonth(now);
  try {
    const u = (await Bun.file(USAGE_PATH).json()) as TtsUsage;
    if (u.month === month) return u;
  } catch { /* first run, or rolled over into a new month */ }
  return { month, chars: 0, requests: 0 };
}

async function writeUsage(u: TtsUsage): Promise<void> {
  mkdirSync(join(ROOT, "data"), { recursive: true });
  await Bun.write(USAGE_PATH, JSON.stringify(u, null, 2));
}

const requestTimes: number[] = [];
async function throttle(): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (requestTimes.length && now - requestTimes[0]! > F0_WINDOW_MS) requestTimes.shift();
    if (requestTimes.length < F0_MAX_REQUESTS_PER_WINDOW) { requestTimes.push(now); return; }
    const waitMs = F0_WINDOW_MS - (now - requestTimes[0]!) + 50;
    await Bun.sleep(waitMs);
  }
}

export function azureConfigured(): boolean {
  return Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION);
}

export const DEFAULT_VOICE = process.env.AZURE_SPEECH_VOICE ?? "ja-JP-NanamiNeural";

/**
 * macOS ja_JP voices to draw from. The real exam uses several speakers, so
 * hearing every word in one voice trains recognition of that waveform rather
 * than of the phonemes — the あける/あげる confusion this bank keeps surfacing
 * is exactly the kind that a single speaker hides.
 *
 * Override with MACOS_JA_VOICES="A,B,C"; check what is installed with
 * `say -v '?' | grep ja_JP`.
 */
export const MACOS_JA_VOICES: readonly string[] =
  (process.env.MACOS_JA_VOICES ?? "Kyoko,Eddy,Flo,Reed,Sandy,Shelley")
    .split(",").map((s) => s.trim()).filter((s) => s !== "");

/**
 * Azure ja-JP neural voices to draw from, for the same reason as the macOS
 * list: one speaker trains waveform recall, not phoneme discrimination.
 * Four female and four male, mirroring the exam's mixed speakers.
 * `AZURE_SPEECH_VOICE` still pins a single voice when set.
 */
export const AZURE_JA_VOICES: readonly string[] =
  (process.env.AZURE_SPEECH_VOICES ?? [
    "ja-JP-NanamiNeural", "ja-JP-AoiNeural", "ja-JP-MayuNeural", "ja-JP-ShioriNeural",
    "ja-JP-KeitaNeural", "ja-JP-DaichiNeural", "ja-JP-NaokiNeural",
    "ja-JP-MasaruMultilingualNeural",
  ].join(","))
    .split(",").map((s) => s.trim()).filter((s) => s !== "");

function pick(list: readonly string[], fallback: string, rng: () => number): string {
  return list[Math.floor(rng() * list.length)] ?? fallback;
}

/** Pick one of the configured macOS voices. */
export function pickMacVoice(rng: () => number = Math.random): string {
  return pick(MACOS_JA_VOICES, "Kyoko", rng);
}

/** Pick one of the configured Azure voices, unless AZURE_SPEECH_VOICE pins one. */
export function pickAzureVoice(rng: () => number = Math.random): string {
  return process.env.AZURE_SPEECH_VOICE ?? pick(AZURE_JA_VOICES, "ja-JP-NanamiNeural", rng);
}

/**
 * One roll for both providers. Callers that rotated only the macOS voice would
 * silently fall back to a single Azure speaker the moment a key was set — the
 * bug this shape exists to prevent.
 */
export function pickVoices(rng: () => number = Math.random): { voice: string; macVoice: string } {
  return { voice: pickAzureVoice(rng), macVoice: pickMacVoice(rng) };
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

/** Exported for tests: the key must include the voice, or clips cross-serve. */
export function cacheKey(text: string, voice: string, rate: string): string {
  return new Bun.CryptoHasher("sha256").update(`${voice}|${rate}|${text}`).digest("hex").slice(0, 20);
}

export interface SpeakOptions {
  /** Azure neural voice name, e.g. "ja-JP-NanamiNeural". */
  voice?: string;
  /**
   * macOS `say` voice name, e.g. "Kyoko". Kept separate from `voice` because
   * the two namespaces are disjoint — handing an Azure name to `say` fails.
   */
  macVoice?: string;
  /** SSML prosody rate, e.g. "-20%" for JLPT-style slow listening practice. */
  rate?: string;
  /** Never call the network; return null if not already cached. */
  cacheOnly?: boolean;
}

export interface SynthResult {
  path: string;
  provider: "azure" | "macos" | "cache";
  /** The voice actually used, so a caller can report or reproduce it. */
  voice: string;
  /**
   * Whether the clip reached the speakers. Set only by speak(); synthesize()
   * leaves it undefined because it never plays anything.
   */
  played?: boolean;
  charsBilled: number;
}

/** Synthesize `text` to a cached audio file. Returns null if unavailable. */
export async function synthesize(text: string, opts: SpeakOptions = {}): Promise<SynthResult | null> {
  const voice = opts.voice ?? DEFAULT_VOICE;
  const macVoice = opts.macVoice ?? process.env.MACOS_JA_VOICE ?? "Kyoko";
  const rate = opts.rate ?? "0%";
  mkdirSync(AUDIO_DIR, { recursive: true });

  const useAzure = azureConfigured();
  const ext = useAzure ? "mp3" : "aiff";
  // The key must name the voice actually used. Hardcoding it meant switching
  // macOS voices silently replayed the previous voice's cached clip.
  const activeVoice = useAzure ? voice : macVoice;
  const path = join(AUDIO_DIR, `${cacheKey(text, activeVoice, rate)}.${ext}`);
  // A zero-byte file means a previous synthesis died partway. Treat it as a miss,
  // otherwise a single transient failure poisons the cache entry permanently.
  if (existsSync(path)) {
    if (statSync(path).size > 0) return { path, provider: "cache", voice: activeVoice, charsBilled: 0 };
    rmSync(path, { force: true });
  }
  if (opts.cacheOnly) return null;
  const tmp = `${path}.part`;

  if (useAzure) {
    const usage = await readUsage();
    if (usage.chars + text.length > F0_MONTHLY_CHARS) {
      console.error(
        `[tts] Azure F0 monthly cap reached (${usage.chars}/${F0_MONTHLY_CHARS} chars). Falling back to macOS voice.`,
      );
    } else {
      await throttle();
      const ssml =
        `<speak version='1.0' xml:lang='ja-JP'><voice name='${voice}'>` +
        `<prosody rate='${rate}'>${escapeXml(text)}</prosody></voice></speak>`;
      const res = await fetch(
        `https://${process.env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
        {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": process.env.AZURE_SPEECH_KEY!,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
            "User-Agent": "jlpt-study-cli",
          },
          body: ssml,
        },
      );
      if (res.ok) {
        const bytes = await res.arrayBuffer();
        if (bytes.byteLength > 0) {
          await Bun.write(tmp, bytes);
          renameSync(tmp, path); // atomic: readers never observe a partial file
          await writeUsage({ month: usage.month, chars: usage.chars + text.length, requests: usage.requests + 1 });
          return { path, provider: "azure", voice, charsBilled: text.length };
        }
        console.error("[tts] Azure returned an empty body; falling back to macOS voice.");
      } else {
        console.error(`[tts] Azure ${res.status} ${res.statusText}; falling back to macOS voice.`);
      }
    }
  }

  if (process.platform !== "darwin") return null;
  // `say` rate is words/min; approximate the SSML percentage.
  const pct = Number.parseInt(rate, 10) || 0;
  const wpm = Math.max(90, Math.round(180 * (1 + pct / 100)));
  // `say -o` infers the container from the extension; LEF32 is rejected for AIFF.
  const proc = Bun.spawn(["say", "-v", macVoice, "-r", String(wpm), "-o", tmp, text], {
    stdout: "ignore", stderr: "pipe",
  });
  if ((await proc.exited) !== 0 || !existsSync(tmp) || statSync(tmp).size === 0) {
    console.error(`[tts] macOS say failed: ${(await new Response(proc.stderr).text()).trim()}`);
    rmSync(tmp, { force: true });
    return null;
  }
  renameSync(tmp, path);
  return { path, provider: "macos", voice: macVoice, charsBilled: 0 };
}

/** Synthesize (if needed) and play through the speakers. */
export async function speak(text: string, opts: SpeakOptions = {}): Promise<SynthResult | null> {
  const r = await synthesize(text, opts);
  if (!r) return null;
  return { ...r, played: await play(r.path) };
}

/**
 * Play a cached clip. Returns whether it was actually heard.
 *
 * The exit code used to be discarded, which is only harmless for audio that
 * decorates a question. For a listening card the audio IS the question, so a
 * silent failure presented an unanswerable card and graded the guess. macOS
 * CoreAudio wedges on sleep/wake often enough that this is a routine state, not
 * an exotic one: afplay then exits non-zero with "AudioQueueStart failed".
 */
export async function play(path: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const proc = Bun.spawn(["afplay", path], { stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) === 0) return true;
  const why = (await new Response(proc.stderr).text()).trim();
  console.error(`[tts] playback failed: ${why || "afplay exited non-zero"}`);
  return false;
}

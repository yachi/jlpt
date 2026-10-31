/**
 * The contract between the UI and the device.
 *
 * Who owns what:
 *  - ../src (core, shared with the CLI): ALL study logic -- seedFrom,
 *    nextQuestion, grade, introduceCard, checkAnswer, stats. It only ever sees
 *    `Platform.db`, through the bun:sqlite-shaped `Db` interface.
 *  - platform/ (this folder): turning a device into a `Db` and a voice. sql.js
 *    in memory, persisted as a whole study.db file (Capacitor Filesystem,
 *    Directory.Data; IndexedDB in a desktop browser), and Japanese TTS.
 *  - UI (everything else in app/src): screens. It never issues PRAGMAs, never
 *    touches files, and never decides when to write to disk.
 *
 * Persistence is Filesystem, not Preferences: Preferences is string-only
 * SharedPreferences XML re-parsed on every launch, wrong for a 1-5 MB binary;
 * a real study.db file is also readable by the CLI's bun:sqlite, so a backup
 * moves between phone and desktop unchanged.
 */
import type { Db } from "../../../src/sqlite";

/** Where vite.config.ts places sql.js's engine (fixed name, next to index.html). */
export const SQL_WASM_URL = "./sql-wasm.wasm";

export interface SpeakOptions {
  /** BCP-47 language; Japanese unless a caller has a reason. */
  lang?: string;
  /** 1 = normal. The CLI plays at -10%, so the app's default is 0.9. */
  rate?: number;
}

export interface Platform {
  /**
   * The open database, schema created and migrated, foreign_keys ON.
   * Every write through it marks the store dirty; the platform flushes it
   * (debounced, and on app pause) -- the UI does not have to call save().
   */
  readonly db: Db;

  /**
   * Flush now and resolve when study.db is durably written (tmp file + rename,
   * so a kill mid-write cannot corrupt it). For "Export"/"Quit" moments.
   */
  save(): Promise<void>;

  /**
   * Speak `text`; resolves true when it was actually played to the end, false
   * when no Japanese voice exists. A listening card that was not heard must
   * NOT be graded (mirrors cli.ts `unheardCard`): the UI shows the reading instead.
   */
  speak(text: string, opts?: SpeakOptions): Promise<boolean>;

  /** Whether speak() can work at all, so the UI can explain before the first card. */
  canSpeak(): Promise<boolean>;

  /** Opens Android's TTS settings, where the Google Japanese voice data is installed. */
  openTtsSettings(): Promise<void>;

  /** The whole database as SQLite file bytes; share-backup.ts hands them to the user. */
  exportBackup(): Promise<Uint8Array>;

  /**
   * Replace the database with a backup's bytes. Rejects (leaving the current
   * database untouched) if the bytes are not a study.db this schema can open.
   * The same `db` object stays valid; a backup from the desktop CLI is
   * migrated and has the app's word lists seeded into it. The UI should
   * re-render everything it derived from the old deck (simplest: reload).
   */
  importBackup(bytes: Uint8Array): Promise<void>;
}

/**
 * Open the platform once at startup. Implemented in platform/index.ts.
 *
 * Seeding IS done here (platform/open.ts): on first launch, and whenever the
 * BANK_FILES_HASH stored in settings differs from the bundled lists, it runs
 * `seedFrom(db, BANK_FILES)` before resolving, so the UI never sees an empty
 * deck; callers do not seed. The sentence corpus is NOT imported in v1: sentence listening
 * stays off and every sentence query simply finds no rows.
 */
export type InitPlatform = () => Promise<Platform>;

/**
 * Everything initPlatform() does that does not need a device: open sql.js
 * from stored bytes, create/migrate the schema, seed when the bundled word
 * lists changed, and keep the store in step with the in-memory database.
 *
 * Capacitor-free so that app/test runs exactly this code in Node with a
 * MemoryStore; index.ts only adds the device pieces (Filesystem, TTS, the
 * App pause event) around it.
 */
import type { SqlJsStatic } from "sql.js";
import type { BankFiles } from "../../../src/bank";
import { seedFrom } from "../../../src/bank";
import { getSetting, initSchema, setSetting } from "../../../src/schema";
import { SqlJsDb } from "./sqljs-db";
import { looksLikeSqlite, type ByteStore } from "./store";
import type { Speech } from "./speech-base";
import type { Platform } from "./types";

/**
 * Coalesces writes into whole-file saves.
 *
 * Debounced because one grade() is several statements and a teach-first card
 * is followed by a grade seconds later: saving per statement would export the
 * file several times per tap. Serialized because two saves racing on
 * study.db.tmp could rename a half-written file into place.
 */
export class Persister {
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  /** The last background save's failure, for the UI to surface; cleared by a successful save. */
  lastError: unknown = null;

  constructor(private db: SqlJsDb, private store: ByteStore, private delayMs = 300) {}

  get isDirty(): boolean { return this.dirty; }

  markDirty(): void {
    this.dirty = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      // A background save has no caller to reject to; keep the error for the
      // UI, and leave the store dirty so the next save retries it.
      this.flush().catch((e) => { this.lastError = e; console.error("study.db save failed", e); });
    }, this.delayMs);
  }

  /** Save now if anything changed; resolves when the store has it. */
  flush(): Promise<void> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    // .catch first: one failed save must not poison every later one.
    this.chain = this.chain.catch(() => {}).then(() => this.write());
    return this.chain;
  }

  private async write(): Promise<void> {
    if (!this.dirty) return;
    // Cleared BEFORE the export: a write that lands while the store's save is
    // in flight sets it again and gets a save of its own.
    this.dirty = false;
    let bytes: Uint8Array;
    try {
      bytes = this.db.export();
      await this.store.save(bytes);
    } catch (e) {
      this.dirty = true;
      throw e;
    }
    this.lastError = null;
  }
}

/** What to seed from; passed by index.ts (Vite `?raw`) or a test (fs). */
export interface BankSource {
  files: BankFiles;
  /** Identity of `files`; seeding re-runs whenever the stored value differs. */
  hash: string;
  /** settings key the hash is stored under. */
  hashKey: string;
}

export interface OpenOptions {
  SQL: SqlJsStatic;
  store: ByteStore;
  speech: Speech;
  bank?: BankSource;
  /** Debounce for background saves. */
  saveDelayMs?: number;
  now?: () => number;
}

/** The Platform plus the handles tests need; index.ts returns it as a plain Platform. */
export interface OpenedPlatform extends Platform {
  readonly db: SqlJsDb;
  readonly persister: Persister;
  /** Result of seeding during open, or null when the stored bank was current. */
  readonly seeded: ReturnType<typeof seedFrom> | null;
}

/**
 * Prepare a connection for use: schema + migrations, then seed if the
 * bundled lists changed. Returns whether it seeded.
 */
function prepare(db: SqlJsDb, bank: BankSource | undefined, now: number): ReturnType<typeof seedFrom> | null {
  initSchema(db);
  if (!bank || getSetting(db, bank.hashKey, "") === bank.hash) return null;
  // seedFrom is idempotent (ON CONFLICT DO NOTHING) and leaves review history
  // alone; it is also what drops sentence links if item identity changed.
  const r = seedFrom(db, bank.files, now);
  setSetting(db, bank.hashKey, bank.hash);
  return r;
}

const schemaVersion = (db: SqlJsDb) =>
  db.query<{ schema_version: number }, []>("PRAGMA schema_version").get()!.schema_version;

/**
 * Check that `bytes` is a study.db we can use, and bring it up to the current
 * schema. Throws (touching nothing else) if not.
 */
function openCandidate(SQL: SqlJsStatic, bytes: Uint8Array): SqlJsDb {
  if (!looksLikeSqlite(bytes)) throw new Error("not a SQLite database file");
  const db = SqlJsDb.open(SQL, bytes);
  try {
    const ok = db.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check;
    if (ok !== "ok") throw new Error(`database is damaged (${ok ?? "no result"})`);
    // A SQLite file of some other app would open fine; require our two core
    // tables so a mis-picked file cannot replace the deck with an empty one.
    const tables = new Set(db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    for (const t of ["items", "cards"]) if (!tables.has(t)) throw new Error(`not a study.db (no ${t} table)`);
    initSchema(db); // a backup from an older CLI gets the same migrations the CLI would run
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

export async function openPlatform(o: OpenOptions): Promise<OpenedPlatform> {
  const now = o.now ?? Date.now;
  const stored = await o.store.load();
  // A stored file that cannot be opened is NOT replaced with a fresh deck:
  // that would overwrite months of reviews on the next save. Fail loudly and
  // let the UI show the error (the file stays where it is).
  const db = stored ? openCandidate(o.SQL, stored) : SqlJsDb.open(o.SQL);
  const before = stored ? schemaVersion(db) : -1;
  const persister = new Persister(db, o.store, o.saveDelayMs);
  const seeded = prepare(db, o.bank, now());

  // Only now start tracking writes, so that opening an up-to-date file does
  // not rewrite it -- unless open itself changed something (first launch, a
  // migration, a re-seed), which must reach the store.
  db.setOnWrite(() => persister.markDirty());
  if (!stored || seeded || schemaVersion(db) !== before) persister.markDirty();

  return {
    db,
    persister,
    seeded,
    save: () => persister.flush(),
    speak: (text, opts) => o.speech.speak(text, opts),
    canSpeak: () => o.speech.canSpeak(),
    openTtsSettings: () => o.speech.openSettings(),
    async exportBackup() {
      await persister.flush();
      return db.export();
    },
    async importBackup(bytes) {
      const candidate = openCandidate(o.SQL, bytes);
      // Flush first so that, if anything below fails, the store holds the
      // current deck rather than whatever was saved before the last answers.
      await persister.flush();
      db.replace(candidate.detach());
      prepare(db, o.bank, now()); // a desktop backup carries no app bank hash: seed the app's lists into it
      await persister.flush();
    },
  };
}

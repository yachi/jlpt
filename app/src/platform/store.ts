/**
 * Where study.db's bytes live between launches.
 *
 * The whole file is read at startup and rewritten on save: sql.js is an
 * in-memory engine with no VFS onto device storage. At 0.6-5 MB that is tens
 * of milliseconds over the bridge, and a whole-file write makes atomicity easy
 * (write a temp file, then rename) where page-level persistence would not.
 */

export interface ByteStore {
  /** The last saved bytes, or null on a first launch. */
  load(): Promise<Uint8Array | null>;
  /** Replace the stored bytes; resolves once they are durable. */
  save(bytes: Uint8Array): Promise<void>;
  /** For diagnostics/settings: where the file is. */
  readonly description: string;
}

export const DB_FILE = "study.db";
export const TMP_FILE = "study.db.tmp";

/** Every SQLite file starts with this; anything else is not a database. */
const SQLITE_MAGIC = "SQLite format 3\u0000";

export function looksLikeSqlite(bytes: Uint8Array): boolean {
  if (bytes.length < 100) return false; // the header alone is 100 bytes
  for (let i = 0; i < SQLITE_MAGIC.length; i++) if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  return true;
}

/**
 * Desktop browser (`vite dev`): IndexedDB, which stores a Uint8Array natively.
 * One put() is atomic, so no temp-file dance is needed.
 */
export class IndexedDbStore implements ByteStore {
  readonly description = "IndexedDB jlpt/files/study.db";
  private dbp: Promise<IDBDatabase> | null = null;

  async load(): Promise<Uint8Array | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = db.transaction("files").objectStore("files").get(DB_FILE);
      req.onsuccess = () => resolve(req.result instanceof Uint8Array ? req.result : null);
      req.onerror = () => reject(req.error);
    });
  }

  async save(bytes: Uint8Array): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("files", "readwrite");
      tx.objectStore("files").put(bytes, DB_FILE);
      // complete, not the put's onsuccess: only then is it committed.
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
    });
  }

  private open(): Promise<IDBDatabase> {
    this.dbp ??= new Promise((resolve, reject) => {
      const req = indexedDB.open("jlpt", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("files");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbp;
  }
}

/** Tests and a last resort when storage is unavailable: nothing survives a reload. */
export class MemoryStore implements ByteStore {
  readonly description = "memory (not persisted)";
  bytes: Uint8Array | null = null;
  saves = 0;
  async load() { return this.bytes; }
  async save(bytes: Uint8Array) { this.bytes = bytes.slice(); this.saves++; }
}

// btoa/atob take "binary strings"; building one with a single
// String.fromCharCode(...bytes) overflows the call stack on a MB-sized file.
const CHUNK = 0x8000;

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

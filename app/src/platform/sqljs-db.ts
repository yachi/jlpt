/**
 * The core's `Db` (src/sqlite.ts) on top of sql.js.
 *
 * No Capacitor or DOM imports here on purpose: this file is the one piece of
 * the platform whose bugs would corrupt study data silently, so it has to be
 * loadable in Node, where app/test drives the real core through it and
 * compares the result with bun:sqlite.
 *
 * sql.js quirks this absorbs, so that the core can keep assuming bun:sqlite:
 *  - `Database.export()` closes and reopens the connection. That FREES every
 *    prepared statement and drops per-connection PRAGMAs (foreign_keys), and an
 *    open transaction would be lost. So statements are resolved lazily through
 *    a cache that export() clears, foreign_keys is reissued after each export,
 *    and exporting inside a transaction is refused.
 *  - `get()` with no row must be `null`, not `undefined` (callers use `!.n`
 *    and `?.v`, and `=== null` in tests).
 *  - Binding `undefined` throws in sql.js; bun:sqlite binds it as NULL.
 *  - `changes` must be the count for THIS statement (quiz.grade() gates the
 *    sentence counter on it), so it is read right after the step.
 */
import type { Database as SqlJsDatabase, SqlJsStatic, Statement } from "sql.js";
import type { Db, SqlValue, Stmt } from "../../../src/sqlite";

/**
 * SQL that cannot change the file. Anything else marks the store dirty --
 * erring towards an unnecessary save, never towards a lost review. `WITH` is
 * deliberately NOT here: a CTE can front an INSERT/UPDATE.
 */
const READ_ONLY_RE = /^\s*(SELECT|EXPLAIN|PRAGMA\s+(table_info|index_list|schema_version|user_version|integrity_check|quick_check)\b)/i;

/** What foreign_keys etc. must be after every (re)open of the connection. */
const CONNECTION_PRAGMAS = "PRAGMA foreign_keys = ON;";

export class SqlJsDb implements Db {
  private raw: SqlJsDatabase;
  /** sql text -> prepared statement. Cleared whenever sql.js frees them. */
  private cache = new Map<string, Statement>();
  /** Transaction nesting depth; >0 means BEGIN (and maybe SAVEPOINTs) is open. */
  private depth = 0;
  private closed = false;

  /**
   * @param onWrite called after any statement that may have changed the file;
   *   the persister debounces a save off it. Never called inside a transaction
   *   until it commits, so a save cannot be scheduled for half a grade().
   */
  constructor(raw: SqlJsDatabase, private onWrite: () => void = () => {}) {
    this.raw = raw;
    this.raw.exec(CONNECTION_PRAGMAS);
  }

  /** Open from file bytes (or empty, for a first launch). */
  static open(SQL: SqlJsStatic, bytes?: Uint8Array | null, onWrite?: () => void): SqlJsDb {
    return new SqlJsDb(bytes && bytes.length > 0 ? new SQL.Database(bytes) : new SQL.Database(), onWrite);
  }

  setOnWrite(fn: () => void): void { this.onWrite = fn; }

  get inTransaction(): boolean { return this.depth > 0; }

  // ------------------------------------------------------------- Db surface

  query<T = unknown, P extends SqlValue | SqlValue[] = SqlValue[]>(
    sql: string): Stmt<T, P extends any[] ? P : [P]> {
    // The wrapper holds only the SQL text, never a Statement: a caller may keep
    // it across an export() (seedFrom keeps insItem across two transactions),
    // and the Statement it was first compiled to is freed by then.
    const writes = !READ_ONLY_RE.test(sql);
    const self = this;
    const stmt: Stmt<T, SqlValue[]> = {
      get(...params) {
        const s = self.prepared(sql, params);
        try {
          const row = s.step() ? (s.getAsObject() as T) : null;
          if (writes) self.wrote();
          return row;
        } finally { s.reset(); }
      },
      all(...params) {
        const s = self.prepared(sql, params);
        try {
          const rows: T[] = [];
          while (s.step()) rows.push(s.getAsObject() as T);
          if (writes) self.wrote();
          return rows;
        } finally { s.reset(); }
      },
      run(...params) {
        const s = self.prepared(sql, params);
        try {
          while (s.step()) { /* drain: a RETURNING row would otherwise leave it mid-statement */ }
          const changes = writes ? self.raw.getRowsModified() : 0;
          if (writes) self.wrote();
          return { changes };
        } finally { s.reset(); }
      },
    };
    return stmt as unknown as Stmt<T, P extends any[] ? P : [P]>;
  }

  exec(sql: string): void {
    this.live().exec(sql);
    if (!READ_ONLY_RE.test(sql)) this.wrote();
  }

  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      // Nested calls become SAVEPOINTs, as in bun:sqlite: a plain nested BEGIN
      // is an error in SQLite. No core path nests today; this is so one that
      // starts to cannot half-commit.
      const sp = this.depth === 0 ? null : `sp${this.depth}`;
      this.live().exec(sp ? `SAVEPOINT ${sp}` : "BEGIN");
      this.depth++;
      let result: R;
      try {
        result = fn(...args);
      } catch (e) {
        this.depth--;
        // Some errors (SQLITE_FULL, IOERR) make SQLite roll back on its own,
        // and a second ROLLBACK then fails with "no transaction is active".
        // That must not replace the error that actually explains the failure.
        try { this.raw.exec(sp ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : "ROLLBACK"); } catch { /* see above */ }
        throw e;
      }
      // Commit before dropping depth: if COMMIT throws, SQLite still has the
      // transaction open, so roll it back rather than leave the adapter
      // believing none is active (the next BEGIN would then fail).
      try {
        this.raw.exec(sp ? `RELEASE ${sp}` : "COMMIT");
      } catch (e) {
        try { this.raw.exec(sp ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : "ROLLBACK"); } catch { /* already rolled back */ }
        this.depth--;
        throw e;
      }
      this.depth--;
      if (this.depth === 0) this.wrote();
      return result;
    };
  }

  close(): void {
    if (this.closed) return;
    this.freeAll();
    this.raw.close();
    this.closed = true;
  }

  // ------------------------------------------------------ platform-only API

  /**
   * The whole database as SQLite file bytes. Refused mid-transaction: sql.js
   * implements export by closing the connection, which would roll it back.
   */
  export(): Uint8Array {
    if (this.depth > 0) throw new Error("SqlJsDb.export inside a transaction");
    // Free first so sql.js's own free-all is a no-op and our cache never holds
    // a dead handle, even if export() throws halfway.
    this.freeAll();
    const bytes = this.live().export();
    this.raw.exec(CONNECTION_PRAGMAS);
    return bytes;
  }

  /**
   * Swap in a different connection, keeping THIS object. bank.ts caches its
   * gloss index in a WeakMap keyed by the Db object (re-stamped by row count
   * and gloss length on every use), and the UI may hold `platform.db`; both
   * stay valid across a backup import this way.
   */
  replace(raw: SqlJsDatabase): void {
    if (this.depth > 0) throw new Error("SqlJsDb.replace inside a transaction");
    this.freeAll();
    if (!this.closed) this.raw.close();
    this.raw = raw;
    this.closed = false;
    this.raw.exec(CONNECTION_PRAGMAS);
    this.wrote();
  }

  /**
   * Give up the connection without closing it (for replace() on another
   * adapter). This adapter is unusable afterwards.
   */
  detach(): SqlJsDatabase {
    if (this.depth > 0) throw new Error("SqlJsDb.detach inside a transaction");
    this.freeAll();
    this.closed = true;
    return this.raw;
  }

  // ---------------------------------------------------------------- internal

  private live(): SqlJsDatabase {
    if (this.closed) throw new Error("database is closed");
    return this.raw;
  }

  private prepared(sql: string, params: unknown[]): Statement {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.live().prepare(sql);
      this.cache.set(sql, s);
    }
    // bind() resets and clears earlier bindings itself.
    s.bind(params.map(toBindable));
    return s;
  }

  private freeAll(): void {
    for (const s of this.cache.values()) {
      try { s.free(); } catch { /* already freed by sql.js */ }
    }
    this.cache.clear();
  }

  private wrote(): void {
    if (this.depth === 0) this.onWrite();
  }
}

/**
 * bun:sqlite's binding rules for the values the core passes. Numbers go
 * through unchanged: sql.js binds non-int32 numbers (every epoch-ms timestamp)
 * as REAL, and INTEGER column affinity stores them back as exact integers --
 * asserted in app/test so a sql.js upgrade cannot quietly change it.
 */
function toBindable(v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number" || typeof v === "string") return v;
  throw new TypeError(`cannot bind ${typeof v} to SQLite`);
}

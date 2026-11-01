/**
 * The database surface the study logic depends on.
 *
 * This is exactly the subset of bun:sqlite's `Database` that quiz.ts, bank.ts,
 * sentences.ts and schema.ts call -- nothing more -- so that the same logic can
 * run on sql.js inside the Android WebView. It mirrors bun:sqlite's shape
 * rather than inventing a new one: `Database` satisfies it structurally, so the
 * CLI and every test keep passing a plain bun:sqlite handle with no wrapper.
 *
 * What is deliberately absent, because no core call site uses it (grep before
 * adding): `$named` / object bindings, `.values()`, `db.prepare`, `db.run`,
 * `lastInsertRowid`, bigint/blob bindings. Every one of them would be one more
 * thing the sql.js adapter has to get exactly right.
 */

/** Positional bind values. Epoch-ms timestamps are plain numbers. */
export type SqlValue = string | number | null;

export interface Stmt<T = unknown, P extends SqlValue[] = SqlValue[]> {
  /** First row, or `null` when there is none (bun:sqlite semantics, not `undefined`). */
  get(...params: P): T | null;
  all(...params: P): T[];
  /** `changes` is the row count of THIS statement; quiz.grade() relies on it. */
  run(...params: P): { changes: number };
}

export interface Db {
  /**
   * Compile `sql`; the statement may be cached and reused by the caller.
   * The `P extends any[] ? P : [P]` is bun:sqlite's own spelling: TS
   * compares generic methods by their declared shape, and a plain `Stmt<T, P>`
   * here makes `Database` fail to satisfy this interface.
   */
  query<T = unknown, P extends SqlValue | SqlValue[] = SqlValue[]>(
    sql: string): Stmt<T, P extends any[] ? P : [P]>;
  /** Run one or more `;`-separated statements with no bindings and no result. */
  exec(sql: string): void;
  /**
   * Wrap `fn` so each call runs inside BEGIN/COMMIT, rolling back and
   * rethrowing if it throws. Returns the wrapper; it does not call `fn`.
   */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
  close(): void;
}

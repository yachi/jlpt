/**
 * Reads the bundled data/ files for the CLI and tests.
 *
 * This is the ONLY core module that touches the filesystem. bank.ts and
 * sentences.ts take file contents through their *From() functions; their
 * historical async seed()/importSentences()/... entry points read files here,
 * so the CLI and every existing test behave exactly as before.
 *
 * It must still be importable (never called) from the Android bundle, because
 * those wrappers live next to the pure functions. Hence: no node:* or bun:*
 * imports, paths resolved from import.meta.url lazily, and `Bun` reached
 * through globalThis with a local type -- the app's tsconfig has no bun-types,
 * and referencing the global by name would fail its typecheck.
 */

interface FileLike { exists(): Promise<boolean>; text(): Promise<string> }

function file(name: string): FileLike {
  const bun = (globalThis as unknown as { Bun?: { file(p: string | URL): FileLike } }).Bun;
  if (!bun) throw new Error(`data/${name}: file loading needs Bun; pass the contents to the *From() variant instead`);
  // A variable, not a literal: a literal `new URL("../data/…", import.meta.url)`
  // is rewritten by Vite into a bundled asset, which would pull the 8 MB corpus
  // into the app even though the app never calls this.
  const rel = "../data/" + name;
  return bun.file(new URL(rel, import.meta.url));
}

/** Contents of data/<name>, or null when the file is absent (optional inputs). */
export async function readDataFile(name: string): Promise<string | null> {
  const f = file(name);
  return (await f.exists()) ? f.text() : null;
}

/** Contents of an arbitrary path (a test's temp corpus); throws when missing. */
export async function readPath(path: string): Promise<string> {
  const bun = (globalThis as unknown as { Bun?: { file(p: string): FileLike } }).Bun;
  if (!bun) throw new Error(`${path}: file loading needs Bun`);
  return bun.file(path).text();
}

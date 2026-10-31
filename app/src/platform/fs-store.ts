/**
 * The Android ByteStore. Split from store.ts because it imports Capacitor,
 * and store.ts must stay loadable in Node for app/test.
 */
import { Directory, Filesystem } from "@capacitor/filesystem";
import { type ByteStore, DB_FILE, TMP_FILE, fromBase64, looksLikeSqlite, toBase64 } from "./store";

/**
 * Android: a real file in the app's private files dir (Directory.Data).
 *
 * Not Preferences (string-only XML, reparsed on every launch) and not the
 * WebView's IndexedDB (owned by the WebView, invisible to backup and to the
 * desktop CLI). This file is exactly what bun:sqlite opens on a desktop.
 */
export class FilesystemStore implements ByteStore {
  readonly description = `Directory.Data/${DB_FILE}`;

  async load(): Promise<Uint8Array | null> {
    const main = await this.read(DB_FILE);
    if (main && looksLikeSqlite(main)) return main;
    // Only reachable if the app was killed between deleting the old file and
    // renaming the new one into place (see save()): the temp file is then the
    // newest COMPLETE copy, since it was fully written before the delete.
    const tmp = await this.read(TMP_FILE);
    if (tmp && looksLikeSqlite(tmp)) return tmp;
    return main; // null on first launch; a non-SQLite file makes open() fail loudly
  }

  async save(bytes: Uint8Array): Promise<void> {
    // Native writeFile without `encoding` takes base64 and writes raw bytes.
    await Filesystem.writeFile({
      path: TMP_FILE, directory: Directory.Data, data: toBase64(bytes), recursive: true,
    });
    try {
      await Filesystem.rename({ from: TMP_FILE, to: DB_FILE, directory: Directory.Data, toDirectory: Directory.Data });
    } catch {
      // Whether rename replaces an existing file depends on the native
      // implementation (it lives in a separate Ionic library, not this repo),
      // so do not rely on it: delete and retry. load() covers a kill in between.
      await Filesystem.deleteFile({ path: DB_FILE, directory: Directory.Data }).catch(() => {});
      await Filesystem.rename({ from: TMP_FILE, to: DB_FILE, directory: Directory.Data, toDirectory: Directory.Data });
    }
  }

  private async read(path: string): Promise<Uint8Array | null> {
    try {
      const r = await Filesystem.readFile({ path, directory: Directory.Data });
      // Native returns base64 for a read without `encoding`; the web shim can
      // return a Blob. Only native uses this store, but be exact anyway.
      return typeof r.data === "string" ? fromBase64(r.data) : new Uint8Array(await r.data.arrayBuffer());
    } catch {
      return null; // missing file: first launch
    }
  }
}

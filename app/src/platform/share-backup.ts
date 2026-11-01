/**
 * Hand an exported study.db to the user.
 *
 * Kept out of the Platform contract because it is pure delivery, not state:
 * the bytes come from Platform.exportBackup(). On a phone an `<a download>`
 * is silently ignored by the WebView, so the file is written to the app's
 * cache dir and offered through the Android share sheet (Drive, Files, mail,
 * Nearby Share...). The cache path is covered by the template's FileProvider
 * (res/xml/file_paths.xml), which is what lets another app read it.
 */
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { toBase64 } from "./store";

export async function deliverBackup(bytes: Uint8Array, fileName: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/x-sqlite3" }));
    const a = document.createElement("a");
    a.href = url; a.download = fileName;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return;
  }
  const { uri } = await Filesystem.writeFile({
    path: fileName, directory: Directory.Cache, data: toBase64(bytes), recursive: true,
  });
  try {
    await Share.share({ title: "JLPT study backup", files: [uri], dialogTitle: "Save backup to…" });
  } catch (e) {
    // Dismissing the share sheet rejects with "Share canceled"; that is the
    // user's choice, not a failure worth an error toast.
    if (!/cancel/i.test(e instanceof Error ? e.message : String(e))) throw e;
  }
}

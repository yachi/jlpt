/**
 * Device implementation of the Platform contract (see ./types.ts): picks the
 * store and voice for where the app is running, opens the database through
 * open.ts, and saves when the app leaves the foreground.
 */
import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import initSqlJs from "sql.js";
import { BANK_FILES, BANK_FILES_HASH, BANK_FILES_HASH_KEY } from "../bank-files";
import { FilesystemStore } from "./fs-store";
import { openPlatform } from "./open";
import { nativeSpeech, webSpeech } from "./speech";
import { IndexedDbStore, MemoryStore, type ByteStore } from "./store";
import { SQL_WASM_URL, type Platform } from "./types";

export type { Platform, SpeakOptions } from "./types";

export async function initPlatform(): Promise<Platform> {
  // The engine is in dist/ (vite.config.ts); never fetched from a CDN, the
  // phone may be offline. sql.js falls back from instantiateStreaming to an
  // ArrayBuffer if the WebView serves .wasm with the wrong MIME type.
  const SQL = await initSqlJs({ locateFile: () => SQL_WASM_URL });
  const native = Capacitor.isNativePlatform();

  const store: ByteStore = native
    ? new FilesystemStore()
    : typeof indexedDB !== "undefined" ? new IndexedDbStore() : new MemoryStore();

  const platform = await openPlatform({
    SQL,
    store,
    speech: native ? nativeSpeech() : webSpeech(),
    bank: { files: BANK_FILES, hash: BANK_FILES_HASH, hashKey: BANK_FILES_HASH_KEY },
  });

  // Save on the way out, not only on the debounce: Android may kill a paused
  // app without warning, and the debounce window is the only unsaved state.
  // `pause` is the Activity's onPause; visibilitychange/pagehide cover the
  // browser and are a second chance on device. flush() is a no-op when clean.
  const flush = () => { platform.save().catch((e) => console.error("save on pause failed", e)); };
  if (native) void App.addListener("pause", flush);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
  window.addEventListener("pagehide", flush);

  return platform;
}

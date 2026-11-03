/**
 * Extra lines on a revealed word: the reading in romaji and the meaning in
 * Hong Kong Cantonese. Display only; neither changes what is asked or graded.
 */
import cantoneseTsv from "../../../data/cantonese.tsv?raw";
import { parseCantonese, cantoneseFor } from "../../../src/cantonese";
import { kanaToRomaji } from "../../../src/romaji";
import { getSetting } from "../../../src/schema";
import type { Db } from "../../../src/sqlite";
import type { RevealExtras } from "./dom";

/** settings keys (app-only, so `app_` prefixed like the others). */
export const APP_ROMAJI_KEY = "app_show_romaji";
export const APP_CANTONESE_KEY = "app_show_cantonese";

let index: ReturnType<typeof parseCantonese> | null = null;

export function revealExtras(db: Db): RevealExtras {
  const showRomaji = getSetting(db, APP_ROMAJI_KEY, "1") === "1";
  const showYue = getSetting(db, APP_CANTONESE_KEY, "1") === "1";
  return {
    romaji: (reading) => showRomaji ? kanaToRomaji(reading) : null,
    cantonese: (expression, reading) => {
      if (!showYue) return null;
      index ??= parseCantonese(cantoneseTsv);
      // ； reads as two wide gaps between short senses on a phone; a slash is compact.
      return cantoneseFor(index, expression, reading)?.replaceAll("；", " / ") ?? null;
    },
  };
}

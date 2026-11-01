/**
 * The word lists, bundled into the app as text.
 *
 * Imported straight from ../data with `?raw` so the app and the CLI seed from
 * the same bytes: item ids follow CSV insert order and the sentence corpus is
 * keyed to them, so a copied-and-drifted CSV here would silently mislabel words.
 */
import n5 from "../../data/n5.csv?raw";
import n4 from "../../data/n4.csv?raw";
import glossCorrections from "../../data/gloss-corrections.csv?raw";
import falseFriends from "../../data/false-friends.txt?raw";
import type { BankFiles } from "../../src/bank";
import { sha256Hex } from "../../src/sha256";

export const BANK_FILES: BankFiles = { n5, n4, glossCorrections, falseFriends };

/**
 * Identity of the bundled texts. Stored in settings after seeding; when an app
 * update ships changed lists the hashes differ and seedFrom runs again (it is
 * idempotent, and drops sentence links itself if item identity changed).
 */
export const BANK_FILES_HASH = sha256Hex([n5, n4, glossCorrections, falseFriends].join("\u0000"));

/** settings key under which BANK_FILES_HASH of the last seed is stored. */
export const BANK_FILES_HASH_KEY = "app_bank_files_hash";

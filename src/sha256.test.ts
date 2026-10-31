import { test, expect } from "bun:test";
import { sha256Hex } from "./sha256";
import { openDb } from "./db";
import { seed, bankFingerprint } from "./bank";

const bun = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

test("sha256Hex matches Bun.CryptoHasher, including multibyte and block-boundary lengths", () => {
  const fixed = ["", "abc", "日本語の文です。", "食べる|たべる\n", "🍣 emoji is 4 UTF-8 bytes",
    // 55/56/64 bytes straddle the padding boundary, where hand-rolled SHA-256 breaks.
    "x".repeat(55), "x".repeat(56), "x".repeat(63), "x".repeat(64), "y".repeat(10_000)];
  for (const s of fixed) expect(sha256Hex(s)).toBe(bun(s));

  // Seeded LCG, so a failure reproduces.
  let seedN = 12345;
  const rnd = () => (seedN = (seedN * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const alphabet = [..."abcXYZ019|\n あいうアイウ食飲漢字é😀"];
  for (let i = 0; i < 200; i++) {
    let s = "";
    const len = Math.floor(rnd() * 300);
    for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    expect(sha256Hex(s)).toBe(bun(s));
  }
});

test("a fresh seed still fingerprints to data/sentences-bank.json", async () => {
  // The sentence corpus is keyed to this value: changing the hash would make
  // every existing database refuse import-sentences.
  const db = openDb(":memory:");
  await seed(db);
  const expected = (await Bun.file(new URL("../data/sentences-bank.json", import.meta.url)).json()) as
    { fingerprint: string };
  expect(bankFingerprint(db)).toBe(expected.fingerprint);
  db.close();
});

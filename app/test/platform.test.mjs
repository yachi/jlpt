// The platform layer, run in Node against the REAL core and the real word
// lists: the sql.js adapter, persistence through open.ts, and backup
// export/import. Where Bun is installed, the same scripted session also runs
// on bun:sqlite (bun-reference.ts) and the two transcripts must be identical.
//
// .mjs + tsx rather than a test runner: `npm test` already runs
// `node --test test/*.test.mjs`, and tsx lets these files import the core's
// .ts sources unchanged, extension-less imports and all.
import { register } from "tsx/esm/api";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initSqlJs from "sql.js";

register();
const { SqlJsDb } = await import("../src/platform/sqljs-db.ts");
const { openPlatform, Persister } = await import("../src/platform/open.ts");
const { MemoryStore, looksLikeSqlite, toBase64, fromBase64 } = await import("../src/platform/store.ts");
const { japaneseVoices, VoiceRotation, isJapanese } = await import("../src/platform/voices.ts");
const { silentSpeech } = await import("../src/platform/speech-base.ts");
const { bankFiles, drive, snapshot, T0 } = await import("./drive.ts");
const { seedFrom } = await import("../../src/bank.ts");
const { initSchema, setSetting } = await import("../../src/schema.ts");
const { nextQuestion, grade } = await import("../../src/quiz.ts");

const SQL = await initSqlJs();
const FILES = bankFiles();
const EXPECTED = JSON.parse(readFileSync(new URL("../../data/sentences-bank.json", import.meta.url), "utf8"));
const bank = { files: FILES, hash: "test-hash", hashKey: "app_bank_files_hash" };

/** A seeded adapter, as the app has after first launch. */
function seededDb() {
  const db = SqlJsDb.open(SQL);
  initSchema(db);
  seedFrom(db, FILES, T0);
  return db;
}

const hasBun = spawnSync("bun", ["--version"]).status === 0;
const bunRef = (...args) => JSON.parse(execFileSync("bun", [new URL("./bun-reference.ts", import.meta.url).pathname, ...args],
  { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));

// ------------------------------------------------------------------ adapter

test("adapter: bun:sqlite semantics the core relies on", () => {
  const db = SqlJsDb.open(SQL);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b TEXT)");
  assert.equal(db.query("SELECT * FROM t WHERE id = ?").get(1), null, "no row is null, not undefined");
  assert.deepEqual(db.query("SELECT * FROM t").all(), []);

  const ins = db.query("INSERT INTO t (a, b) VALUES (?, ?)");
  assert.equal(ins.run(1, "x").changes, 1);
  assert.equal(ins.run(undefined, "y").changes, 1, "undefined binds as NULL like bun:sqlite");
  assert.equal(db.query("SELECT a FROM t WHERE b = 'y'").get().a, null);
  assert.equal(db.query("UPDATE t SET b = 'z' WHERE a IS NULL OR a = 1").run().changes, 2);
  assert.equal(db.query("UPDATE t SET b = 'q' WHERE id = 99").run().changes, 0, "changes is THIS statement's");
  assert.equal(db.query("SELECT COUNT(*) AS n FROM t").get().n, 2);

  // Epoch ms exceed int32, so sql.js binds them as REAL; INTEGER affinity must
  // store them back as exact integers (cards.due comparisons and the backup's
  // readability by bun:sqlite both depend on it).
  const ms = 1_768_000_000_123;
  db.query("INSERT INTO t (a, b) VALUES (?, 'ms')").run(ms);
  const row = db.query("SELECT a, typeof(a) AS ty FROM t WHERE b = 'ms'").get();
  assert.equal(row.a, ms);
  assert.equal(row.ty, "integer");
  assert.equal(db.query("SELECT COUNT(*) AS n FROM t WHERE a <= ?").get(ms).n, 2);
});

test("adapter: transactions commit, roll back on throw, and nest as savepoints", () => {
  const db = SqlJsDb.open(SQL);
  db.exec("CREATE TABLE t (v INTEGER)");
  const ins = db.query("INSERT INTO t VALUES (?)");
  const count = () => db.query("SELECT COUNT(*) AS n FROM t").get().n;

  assert.equal(db.transaction((n) => { ins.run(n); return "ok"; })(1), "ok");
  assert.equal(count(), 1);

  assert.throws(() => db.transaction(() => { ins.run(2); throw new Error("boom"); })(), /boom/);
  assert.equal(count(), 1, "rolled back");
  assert.equal(db.inTransaction, false);

  const outer = db.transaction(() => {
    ins.run(3);
    assert.throws(() => db.transaction(() => { ins.run(4); throw new Error("inner"); })());
    ins.run(5);
  });
  outer();
  assert.deepEqual(db.query("SELECT v FROM t ORDER BY v").all().map((r) => r.v), [1, 3, 5]);

  // A SQL error inside also rolls back and surfaces the SQL error itself.
  assert.throws(() => db.transaction(() => { ins.run(6); db.query("INSERT INTO nope VALUES (1)").run(); })(), /nope/);
  assert.equal(count(), 3);
});

test("adapter: statements and foreign_keys survive export(), which sql.js implements by reopening", () => {
  const db = SqlJsDb.open(SQL);
  db.exec(`CREATE TABLE p (id INTEGER PRIMARY KEY);
           CREATE TABLE c (pid INTEGER REFERENCES p(id) ON DELETE CASCADE)`);
  const insP = db.query("INSERT INTO p VALUES (?)");
  insP.run(1);
  const bytes = db.export();
  assert.ok(looksLikeSqlite(bytes));
  // The wrapper made before export must still work (seedFrom keeps one across calls).
  insP.run(2);
  assert.equal(db.query("PRAGMA foreign_keys").get().foreign_keys, 1);
  db.query("INSERT INTO c VALUES (2)").run();
  db.query("DELETE FROM p WHERE id = 2").run();
  assert.equal(db.query("SELECT COUNT(*) AS n FROM c").get().n, 0, "cascade ran: foreign_keys is on");
  assert.throws(() => db.transaction(() => db.export())(), /inside a transaction/);
});

test("adapter: reads do not mark the store dirty, writes and commits do", () => {
  let writes = 0;
  const db = SqlJsDb.open(SQL, null, () => writes++);
  db.exec("CREATE TABLE t (v INTEGER)");
  const afterDdl = writes;
  assert.ok(afterDdl > 0);
  db.query("SELECT * FROM t").all();
  db.query("PRAGMA table_info(t)").all();
  assert.equal(writes, afterDdl);
  db.transaction(() => { db.query("INSERT INTO t VALUES (1)").run(); db.query("INSERT INTO t VALUES (2)").run(); })();
  assert.equal(writes, afterDdl + 1, "one notification per committed transaction, none mid-way");
});

// ------------------------------------------------------------- seed + core

test("seed through sql.js: 1,384 words, 5,257 cards, same bank fingerprint as the CLI", () => {
  const db = SqlJsDb.open(SQL);
  initSchema(db);
  const r = seedFrom(db, FILES, T0);
  assert.equal(r.items, 1384);
  assert.equal(r.cards, 5257);
  assert.equal(r.corrections.stale.length, 0);
  assert.equal(r.corrections.missing.length, 0);
  const s = snapshot(db, T0);
  assert.equal(s.fingerprint, EXPECTED.fingerprint, "item ids name the same words the corpus is keyed to");
  assert.equal(EXPECTED.items, 1384);
  assert.ok(db.query("SELECT COUNT(*) AS n FROM false_friends").get().n > 0, "false friends loaded");
  // Idempotent: a re-seed (app update with unchanged lists) changes nothing.
  assert.equal(seedFrom(db, FILES, T0 + 1).cards, 5257);
  assert.equal(snapshot(db, T0).fingerprint, EXPECTED.fingerprint);
});

test("a few dozen answers across all four modes drive the real core on sql.js", () => {
  const db = seededDb();
  setSetting(db, "skip_meaning_for_kanji", "0");
  const s = drive(db, 48, 7);
  const answers = s.steps.filter((x) => x.kind === "answer");
  assert.equal(answers.length, 48);
  const modes = new Set(answers.map((x) => x.mode));
  for (const m of ["meaning", "reading", "listening", "production"]) assert.ok(modes.has(m), `answered a ${m} card`);
  assert.ok(answers.some((x) => x.correct) && answers.some((x) => !x.correct));
  assert.ok(new Set(answers.map((x) => x.rating)).size >= 3, "Again, Hard and Good all occurred");
  const snap = snapshot(db, s.now);
  assert.equal(snap.reviews.length, 48);
  for (const c of snap.introduced) {
    assert.equal(typeof c.due, "number");
    assert.equal(c.due, Math.trunc(c.due), "due stays an integral epoch ms");
  }
});

test("sql.js and bun:sqlite produce identical questions, grades and card state", { skip: hasBun ? false : "bun not installed" }, () => {
  const db = SqlJsDb.open(SQL);
  initSchema(db);
  const seeded = seedFrom(db, FILES, T0);
  const s = drive(db, 60, 42);
  const mine = { seeded, steps: s.steps, snap: snapshot(db, s.now) };
  const ref = bunRef("session", "60", "42");
  assert.equal(mine.steps.length, ref.steps.length);
  for (let i = 0; i < ref.steps.length; i++) assert.deepEqual(mine.steps[i], ref.steps[i], `step ${i}`);
  assert.deepEqual(mine.seeded, ref.seeded);
  assertSameUpToUlp(mine.snap, ref.snap);
});

/**
 * Deep equality, except that two NON-integral numbers may differ in the last
 * couple of ulps. Not an engine difference: Bun runs JavaScriptCore and Node
 * runs V8, and their Math.pow disagree in the last bit for some inputs
 * (measured: 1.9414430366225788 vs ...579), which FSRS stability inherits.
 * Integers -- ids, epoch-ms due dates, ratings, counts -- must match exactly.
 * The Android WebView is V8, like Node, so the device matches these tests.
 */
function assertSameUpToUlp(a, b, path = "$") {
  if (typeof a === "number" && typeof b === "number" && !(Number.isInteger(a) && Number.isInteger(b))) {
    assert.ok(Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a)), `${path}: ${a} vs ${b}`);
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), path);
    for (const k of Object.keys(a)) assertSameUpToUlp(a[k], b[k], `${path}.${k}`);
    return;
  }
  assert.equal(a, b, path);
}

test("sentences absent (v1): sentence listening switched on still serves plain listening cards", () => {
  const db = seededDb();
  setSetting(db, "sentence_listening", "1");
  const s = drive(db, 24, 3);
  const listening = s.steps.filter((x) => x.kind === "answer" && x.mode === "listening");
  assert.ok(listening.length > 0);
  assert.equal(snapshot(db, s.now).reviews.filter((r) => r.sentence_id !== null).length, 0);
});

// ------------------------------------------------------------ persistence

test("first launch seeds and saves; a relaunch opens the saved file without rewriting it", async () => {
  const store = new MemoryStore();
  const p1 = await openPlatform({ SQL, store, speech: silentSpeech, bank, saveDelayMs: 5, now: () => T0 });
  assert.equal(p1.seeded?.items, 1384);
  assert.equal(p1.persister.isDirty, true);
  await p1.save();
  assert.equal(store.saves, 1);

  const s = drive(p1.db, 30, 11);
  await new Promise((r) => setTimeout(r, 30)); // the debounce saves on its own
  assert.equal(p1.persister.isDirty, false);
  assert.ok(store.saves >= 2);

  const savesBefore = store.saves;
  const p2 = await openPlatform({ SQL, store, speech: silentSpeech, bank, saveDelayMs: 5 });
  assert.equal(p2.seeded, null, "bank hash current: no re-seed");
  assert.equal(p2.persister.isDirty, false, "opening an up-to-date file does not rewrite it");
  await p2.save();
  assert.equal(store.saves, savesBefore);
  assert.deepEqual(snapshot(p2.db, s.now), snapshot(p1.db, s.now));

  // Both copies continue identically: nothing the scheduler reads was lost.
  const a = drive(p1.db, 12, 99, s.now);
  const b = drive(p2.db, 12, 99, s.now);
  assert.deepEqual(b.steps, a.steps);
});

test("changed bundled lists re-seed on open, keeping the review history", async () => {
  const store = new MemoryStore();
  const p1 = await openPlatform({ SQL, store, speech: silentSpeech, bank, saveDelayMs: 1 });
  drive(p1.db, 10, 5);
  await p1.save();
  const p2 = await openPlatform({ SQL, store, speech: silentSpeech, bank: { ...bank, hash: "v2" }, saveDelayMs: 1 });
  assert.equal(p2.seeded?.cards, 5257);
  assert.equal(snapshot(p2.db, T0).reviews.length, 10);
  assert.equal(p2.persister.isDirty, true, "the new hash must reach the store");
});

test("export -> import round-trip preserves state; bad bytes are refused and change nothing", async () => {
  const src = await openPlatform({ SQL, store: new MemoryStore(), speech: silentSpeech, bank, saveDelayMs: 1 });
  const s = drive(src.db, 36, 21);
  const backup = await src.exportBackup();
  assert.ok(looksLikeSqlite(backup));

  const store = new MemoryStore();
  const dst = await openPlatform({ SQL, store, speech: silentSpeech, bank, saveDelayMs: 1 });
  const dbBefore = dst.db;
  await dst.importBackup(backup);
  assert.equal(dst.db, dbBefore, "same Db object after import");
  assert.deepEqual(snapshot(dst.db, s.now), snapshot(src.db, s.now));
  assert.ok(store.bytes && looksLikeSqlite(store.bytes), "import was saved");

  const now = s.now;
  const intact = snapshot(dst.db, now);
  await assert.rejects(dst.importBackup(new Uint8Array([1, 2, 3])), /not a SQLite/);
  const other = new SQL.Database();
  other.exec("CREATE TABLE x (y)");
  await assert.rejects(dst.importBackup(other.export()), /no items table/);
  const truncated = backup.slice(0, 8192);
  await assert.rejects(dst.importBackup(truncated));
  assert.deepEqual(snapshot(dst.db, now), intact);

  // Still fully usable after the failed imports.
  const q = nextQuestion(dst.db, { now, rng: () => 0.5 });
  assert.ok(q);
  if (!q.teachFirst) assert.equal(grade(dst.db, q, q.answerIndex, 1000, { now }).correct, true);
});

test("a backup written by sql.js opens in bun:sqlite with identical state (phone -> desktop)", { skip: hasBun ? false : "bun not installed" }, async () => {
  const p = await openPlatform({ SQL, store: new MemoryStore(), speech: silentSpeech, bank, saveDelayMs: 1 });
  const s = drive(p.db, 30, 8);
  const dir = mkdtempSync(join(tmpdir(), "jlpt-app-"));
  try {
    const f = join(dir, "study.db");
    writeFileSync(f, await p.exportBackup());
    const ref = bunRef("read", f, String(s.now));
    assert.deepEqual(ref, snapshot(p.db, s.now));
    assert.equal(ref.fingerprint, EXPECTED.fingerprint);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persister: saves are serialized, a write during a save gets its own save, failures retry", async () => {
  const db = SqlJsDb.open(SQL);
  db.exec("CREATE TABLE t (v)");
  let inFlight = 0, maxInFlight = 0, fail = false;
  const saved = [];
  const store = {
    description: "test",
    async load() { return null; },
    async save(bytes) {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      if (fail) throw new Error("disk full");
      saved.push(bytes);
    },
  };
  const per = new Persister(db, store, 1000);
  db.setOnWrite(() => per.markDirty());
  db.query("INSERT INTO t VALUES (1)").run();
  const f1 = per.flush();
  while (inFlight === 0) await new Promise((r) => setTimeout(r, 1));
  db.query("INSERT INTO t VALUES (2)").run(); // lands while f1's save is in flight
  const f2 = per.flush();
  const f3 = per.flush(); // nothing new since f2: must not write a third copy
  await Promise.all([f1, f2, f3]);
  assert.equal(maxInFlight, 1);
  assert.equal(saved.length, 2);
  const last = new SQL.Database(saved[1]);
  assert.equal(last.exec("SELECT COUNT(*) FROM t")[0].values[0][0], 2);

  fail = true;
  db.query("INSERT INTO t VALUES (3)").run();
  await assert.rejects(per.flush(), /disk full/);
  assert.equal(per.isDirty, true, "failed save leaves it dirty");
  fail = false;
  await per.flush();
  assert.equal(per.isDirty, false);
  assert.equal(saved.length, 3);
});

test("base64 round-trips a MB-sized file without blowing the stack", () => {
  const bytes = new Uint8Array(3 * 1024 * 1024 + 7);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 2654435761) >>> 24;
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
});

// ------------------------------------------------------------------- voices

test("voices: Japanese only, offline preferred, stable rotation", () => {
  assert.ok(isJapanese("ja-JP") && isJapanese("ja_JP") && isJapanese("ja") && isJapanese("jpn"));
  assert.ok(!isJapanese("jv-ID") && !isJapanese("en-US"));
  const all = [
    { name: "en-us-x-sfg-local", lang: "en-US", localService: true },
    { name: "ja-jp-x-jad-local", lang: "ja-JP", localService: true },
    { name: "ja-jp-x-htm-network", lang: "ja-JP", localService: false },
    { name: "ja-jp-x-jac-local", lang: "ja-JP", localService: true },
  ];
  const ja = japaneseVoices(all);
  assert.deepEqual(ja.map((v) => v.index), [3, 1], "local ja voices, name order, original indices");
  const rot = new VoiceRotation(ja);
  assert.deepEqual([rot.next(), rot.next(), rot.next()].map((v) => v.name),
    ["ja-jp-x-jac-local", "ja-jp-x-jad-local", "ja-jp-x-jac-local"]);
  assert.deepEqual(japaneseVoices([all[2]]).map((v) => v.index), [0], "network voice only when nothing local");
  assert.equal(new VoiceRotation(japaneseVoices([all[0]])).next(), null, "no ja voice: nothing to speak with");
});

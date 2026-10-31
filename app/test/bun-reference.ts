/**
 * The bun:sqlite side of the engine comparison in platform.test.mjs.
 * Run by Bun (the CLI's engine), prints JSON on stdout.
 *
 *   bun app/test/bun-reference.ts session <answers> <seed>
 *       fresh in-memory deck, seeded and driven exactly like the sql.js run
 *   bun app/test/bun-reference.ts read <file> <now>
 *       snapshot of a study.db written by sql.js: the phone -> desktop backup path
 */
import { Database } from "bun:sqlite";
import { seedFrom } from "../../src/bank";
import { initSchema } from "../../src/schema";
import { bankFiles, drive, snapshot, T0 } from "./drive";

const [cmd, a, b] = process.argv.slice(2);

if (cmd === "session") {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  initSchema(db);
  const seeded = seedFrom(db, bankFiles(), T0);
  const s = drive(db, Number(a), Number(b));
  console.log(JSON.stringify({ seeded, steps: s.steps, snap: snapshot(db, s.now) }));
} else if (cmd === "read") {
  const db = new Database(a!, { readonly: true });
  console.log(JSON.stringify(snapshot(db, Number(b))));
} else {
  throw new Error(`unknown command ${cmd}`);
}

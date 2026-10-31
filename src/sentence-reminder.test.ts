import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, getSetting, setSetting, ROOT } from "./db";
import { seed } from "./bank";
import {
  sentenceNudge, sentenceNudgeLine, sentenceCoverage,
  SENTENCE_NUDGE_SHARE, SENTENCE_NUDGE_KEY, SENTENCE_SETTING,
} from "./sentences";

const NUDGE = `bun run cli set ${SENTENCE_SETTING} 1`;

describe("sentenceNudge (pure)", () => {
  const base = { enabled: false, listening: 10, shown: false };
  test("below threshold is silent and clears the flag", () => {
    expect(sentenceNudge({ ...base, withSentence: 4 })).toEqual({ show: false, shown: false });
    expect(sentenceNudge({ ...base, withSentence: 4, shown: true })).toEqual({ show: false, shown: false });
  });
  test("at threshold is shown once", () => {
    expect(SENTENCE_NUDGE_SHARE).toBe(0.5);
    expect(sentenceNudge({ ...base, withSentence: 5 })).toEqual({ show: true, shown: true });
  });
  test("not repeated once shown", () => {
    expect(sentenceNudge({ ...base, withSentence: 9, shown: true })).toEqual({ show: false, shown: true });
  });
  test("silent when already enabled", () => {
    expect(sentenceNudge({ ...base, enabled: true, withSentence: 10 }).show).toBe(false);
  });
  test("an empty listening deck is not 'at threshold'", () => {
    expect(sentenceNudge({ ...base, listening: 0, withSentence: 0 }).show).toBe(false);
  });
});

describe("sentence nudge through the CLI", () => {
  let path = "";
  beforeAll(async () => {
    path = join(mkdtempSync(join(tmpdir(), "jlpt-nudge-")), "t.db");
    const db = openDb(path);
    await seed(db);
    // Two introduced, heard listening cards; one sentence covering only the
    // first, all its other words heard -> 1/2 = exactly the threshold.
    const ids = db.query<{ item_id: number }, []>(
      "SELECT item_id FROM cards WHERE mode='listening' ORDER BY item_id LIMIT 2").all().map((r) => r.item_id);
    for (const id of ids) {
      db.query("UPDATE cards SET introduced=1, state='review' WHERE item_id=? AND mode='listening'").run(id);
    }
    db.query("INSERT INTO sentences (id, ja, en, n_items, n_unheard) VALUES (1, 'x', 'x', 1, 0)").run();
    db.query("INSERT INTO sentence_items (sentence_id, item_id) VALUES (1, ?)").run(ids[0]!);
    expect(sentenceCoverage(db)).toMatchObject({ listening: 2, withSentence: 1 });
    db.close();
  });

  const run = (...args: string[]) => {
    const p = Bun.spawnSync(["bun", join(ROOT, "src", "cli.ts"), ...args], {
      env: { ...process.env, JLPT_DB: path, AZURE_SPEECH_KEY: "" },
    });
    return p.stdout.toString() + p.stderr.toString();
  };
  const flag = () => { const db = openDb(path); try { return getSetting(db, SENTENCE_NUDGE_KEY, "0"); } finally { db.close(); } };

  test("absent from --json and does not consume the flag", () => {
    const out = run("stats", "--json");
    expect(out).not.toContain(NUDGE);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(flag()).toBe("0");
  });
  test("stats shows it once at threshold, then not again", () => {
    expect(run("stats")).toContain(NUDGE);
    expect(flag()).toBe("1");
    expect(run("stats")).not.toContain(NUDGE);
  });
  test("re-crossing after dropping below is announced again; never when enabled", () => {
    const db = openDb(path);
    db.query("UPDATE sentences SET n_unheard = 1").run();   // coverage 0/2
    expect(sentenceNudgeLine(db)).toBeNull();
    expect(getSetting(db, SENTENCE_NUDGE_KEY, "?")).toBe("0");
    db.query("UPDATE sentences SET n_unheard = 0").run();
    expect(sentenceNudgeLine(db)).toContain(NUDGE);
    setSetting(db, SENTENCE_NUDGE_KEY, "0");
    setSetting(db, SENTENCE_SETTING, "1");
    expect(sentenceNudgeLine(db)).toBeNull();
    db.close();
    expect(run("stats")).not.toContain(NUDGE);
  });
});

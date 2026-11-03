import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { cantoneseFor, parseCantonese } from "./cantonese";
import { openDb } from "./db";
import { seed } from "./bank";

describe("data/cantonese.tsv", () => {
  test("every word in the bank has a Cantonese gloss", async () => {
    const index = parseCantonese(await readFile(new URL("../data/cantonese.tsv", import.meta.url), "utf8"));
    const db = openDb(":memory:");
    await seed(db);
    const rows = db.query<{ expression: string; reading: string }, []>(
      "SELECT DISTINCT expression, reading FROM items").all();
    const missing = rows.filter((r) => !cantoneseFor(index, r.expression, r.reading))
      .map((r) => `${r.expression}【${r.reading}】`);
    expect({ missing }).toEqual({ missing: [] });
  });

  test("lookups are by expression AND reading", () => {
    const index = parseCantonese("expression\treading\tcantonese\n熱い\tあつい\t熱；燙\n厚い\tあつい\t厚\n");
    expect(cantoneseFor(index, "熱い", "あつい")).toBe("熱；燙");
    expect(cantoneseFor(index, "厚い", "あつい")).toBe("厚");
    expect(cantoneseFor(index, "暑い", "あつい")).toBeUndefined();
  });
});

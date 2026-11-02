/**
 * Hong Kong Cantonese glosses for the word bank (data/cantonese.tsv).
 *
 * Keyed by the CSV's own expression + reading, not by item id: ids follow
 * insert order, and a gloss file keyed to them would silently mislabel words
 * after any list change. The file is display-only, so it is not seeded into
 * study.db and changing it never touches progress.
 */
export type CantoneseIndex = ReadonlyMap<string, string>;

const key = (expression: string, reading: string) => `${expression}\t${reading}`;

export function parseCantonese(tsv: string): CantoneseIndex {
  const out = new Map<string, string>();
  for (const line of tsv.split("\n").slice(1)) {
    const [expression, reading, yue] = line.replace(/\r$/, "").split("\t");
    if (expression === undefined || reading === undefined || !yue) continue;
    out.set(key(expression, reading), yue);
  }
  return out;
}

export function cantoneseFor(index: CantoneseIndex, expression: string, reading: string): string | undefined {
  return index.get(key(expression, reading));
}

import type { InstrumentSummary } from "../api/schemas.ts";

/**
 * Keeps the previous object for every product whose payload is unchanged, so a poll that touches one product
 * does not rebuild the other Overview rows. The array is new when anything changed; it is the previous array
 * when nothing did.
 */
export function retainUnchangedSummaries(
  previous: readonly InstrumentSummary[],
  next: readonly InstrumentSummary[],
): readonly InstrumentSummary[] {
  if (previous === next || previous.length === 0) return next;
  const byRoot = new Map(previous.map((row) => [row.instrument.root, row]));
  let changed = false;
  const rows = next.map((row) => {
    const prior = byRoot.get(row.instrument.root);
    if (prior && JSON.stringify(prior) === JSON.stringify(row)) return prior;
    changed = true;
    return row;
  });
  if (!changed && rows.length === previous.length && rows.every((row, index) => row === previous[index])) return previous;
  return rows;
}

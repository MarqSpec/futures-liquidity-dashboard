import type { HeatColumn } from "../api/schemas.ts";

/** One price of one heatmap slice. */
export interface HeatCell {
  readonly priceTicks: number;
  /** Time-weighted resting bid quantity over the known part of the slice. */
  readonly bid: number;
  /** Time-weighted resting ask quantity over the known part of the slice. */
  readonly ask: number;
  /** How much of the slice's duration the book was known at this price. */
  readonly knownMs: number;
  /** 0 when fully known, 1 when not known at all: never to be drawn as zero liquidity. */
  readonly unknownFraction: number;
}

/**
 * Index of the first column whose slice ends after `ms`. Columns are in time order. A column that ends exactly at
 * `ms` is already outside the window.
 */
export function firstColumnEndingAfter(columns: readonly HeatColumn[], ms: number): number {
  let lo = 0;
  let hi = columns.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const column = columns[mid];
    if (column && column.t + column.d <= ms) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** Calls `visit` for every cell of a column's flat [price, bid, ask, knownMs, …] array without allocating. */
export function forEachHeatCell(
  column: HeatColumn,
  visit: (priceTicks: number, bid: number, ask: number, knownMs: number) => void,
): void {
  const c = column.c;
  for (let i = 0; i + 3 < c.length; i += 4) {
    visit(c[i] ?? 0, c[i + 1] ?? 0, c[i + 2] ?? 0, c[i + 3] ?? 0);
  }
}

/**
 * Log intensity in 0..1. `maxValue` is the largest quantity in the visible window, so one wall does not paint the
 * rest of the window the same colour, and the scale follows what is on screen.
 */
export function logIntensity(value: number, maxValue: number): number {
  if (value <= 0 || maxValue <= 0) {
    return 0;
  }
  return Math.log1p(value) / Math.log1p(maxValue);
}

/**
 * Rolls heatmap columns onto `bucketMs` boundaries. Means are weighted by known milliseconds, which is the integral
 * the server stored before it divided (REQUIREMENTS.md FR-12): resampling never averages the means.
 */
export function aggregateHeat(columns: readonly HeatColumn[], bucketMs: number): HeatColumn[] {
  if (bucketMs <= 0 || columns.length === 0) {
    return [...columns];
  }
  type Acc = { bidMs: number; askMs: number; known: number };
  const buckets = new Map<number, Map<number, Acc>>();
  const order: number[] = [];
  for (const column of columns) {
    const t = Math.floor(column.t / bucketMs) * bucketMs;
    let prices = buckets.get(t);
    if (!prices) {
      prices = new Map();
      buckets.set(t, prices);
      order.push(t);
    }
    forEachHeatCell(column, (price, bid, ask, knownMs) => {
      const cell = prices.get(price) ?? { bidMs: 0, askMs: 0, known: 0 };
      cell.bidMs += bid * knownMs;
      cell.askMs += ask * knownMs;
      cell.known += knownMs;
      prices.set(price, cell);
    });
  }
  return order.map((t) => {
    const prices = buckets.get(t);
    const flat: number[] = [];
    if (prices) {
      for (const [price, cell] of [...prices.entries()].sort((a, b) => a[0] - b[0])) {
        const known = cell.known;
        flat.push(price, known > 0 ? cell.bidMs / known : 0, known > 0 ? cell.askMs / known : 0, known);
      }
    }
    return { t, d: bucketMs, c: flat };
  });
}

/** Decodes a column's flat array into cells. */
export function decodeHeatColumn(column: HeatColumn): HeatCell[] {
  const cells: HeatCell[] = [];
  const duration = column.d > 0 ? column.d : 1;
  forEachHeatCell(column, (priceTicks, bid, ask, knownMs) => {
    cells.push({
      priceTicks,
      bid,
      ask,
      knownMs,
      unknownFraction: Math.min(1, Math.max(0, 1 - knownMs / duration)),
    });
  });
  return cells;
}

/**
 * The resting quantity a heatmap colour is scaled against: the given quantile of the non-zero bid and ask values
 * of the columns, so one huge wall does not wash every other level out. 1 when there is nothing to scale.
 */
export function heatScale(columns: readonly HeatColumn[], quantile = 0.97, sampleLimit = 20_000): number {
  const values: number[] = [];
  const step = Math.max(1, Math.floor(columns.length / 200));
  for (let i = columns.length - 1; i >= 0 && values.length < sampleLimit; i -= step) {
    const column = columns[i];
    if (column) {
      forEachHeatCell(column, (_p, bid, ask) => {
        if (bid > 0) values.push(bid);
        if (ask > 0) values.push(ask);
      });
    }
  }
  if (values.length === 0) {
    return 1;
  }
  values.sort((a, b) => a - b);
  const index = Math.min(values.length - 1, Math.floor(quantile * (values.length - 1)));
  return Math.max(1, values[index] ?? 1);
}

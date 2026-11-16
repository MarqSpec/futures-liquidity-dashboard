import type { Footprint } from "../api/schemas.ts";

/** One price row of a footprint bar. */
export interface FootprintCell {
  readonly priceTicks: number;
  /** Volume that sold into the bid at this price. */
  readonly bid: number;
  /** Volume that bought the offer at this price. */
  readonly ask: number;
  /** +1 diagonal buy imbalance, −1 diagonal sell imbalance, 0 none. */
  readonly imbalance: -1 | 0 | 1;
}

function toFlag(value: number): -1 | 0 | 1 {
  if (value > 0) return 1;
  return value < 0 ? -1 : 0;
}

/** Decodes a footprint's flat [price, bidVolume, askVolume, imbalanceFlag, …] array, highest price first. */
export function decodeFootprint(bar: Footprint): FootprintCell[] {
  const cells: FootprintCell[] = [];
  const c = bar.c;
  for (let i = 0; i + 3 < c.length; i += 4) {
    cells.push({ priceTicks: c[i] ?? 0, bid: c[i + 1] ?? 0, ask: c[i + 2] ?? 0, imbalance: toFlag(c[i + 3] ?? 0) });
  }
  return cells.sort((a, b) => b.priceTicks - a.priceTicks);
}

/** The bar's point of control: the price with the most volume (the lower price on a tie), or null when empty. */
export function footprintPoc(cells: readonly FootprintCell[]): number | null {
  let best: FootprintCell | null = null;
  for (const cell of cells) {
    const volume = cell.bid + cell.ask;
    if (
      best === null ||
      volume > best.bid + best.ask ||
      (volume === best.bid + best.ask && cell.priceTicks < best.priceTicks)
    ) {
      best = cell;
    }
  }
  return best === null || best.bid + best.ask === 0 ? null : best.priceTicks;
}

/**
 * The rows a footprint pane draws for several bars: every price that traded in any of them, highest first. Prices
 * nobody traded are left out, so two clusters far apart do not leave the pane empty in between.
 */
export function footprintRows(bars: readonly (readonly FootprintCell[])[]): number[] {
  const prices = new Set<number>();
  for (const cells of bars) {
    for (const cell of cells) {
      prices.add(cell.priceTicks);
    }
  }
  return [...prices].sort((a, b) => b - a);
}

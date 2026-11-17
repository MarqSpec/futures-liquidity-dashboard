import { LOCK_RELEASE_DRAG_PX, PINCH_PRICE_DEADBAND_PX } from "./bookmap.ts";

// What turns Lock off, read by Detail and Order Flow alike (REQUIREMENTS.md FR-67, FR-68).

/** True once a plot drag that started at `startY` has moved far enough vertically to release Lock. */
export function dragReleasesLock(startY: number, y: number): boolean {
  return Math.abs(y - startY) >= LOCK_RELEASE_DRAG_PX;
}

/** True when a pinch's vertical finger gap has moved far enough from `startGap` to be a price zoom, not jitter. */
export function pinchZoomsPrice(startGap: number, gap: number): boolean {
  return Math.abs(gap - startGap) >= PINCH_PRICE_DEADBAND_PX;
}

/** The price Center and Lock hold in the middle: the last print, or the last candle's close before any print. */
export function lastPriceAnchor(
  prints: readonly { readonly priceTicks: number }[],
  candles: readonly { readonly c: number }[],
): number | null {
  return prints.at(-1)?.priceTicks ?? candles.at(-1)?.c ?? null;
}

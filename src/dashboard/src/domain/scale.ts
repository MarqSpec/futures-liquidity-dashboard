/** A linear map from a domain interval to a pixel interval, and back. */
export interface LinearScale {
  readonly d0: number;
  readonly d1: number;
  readonly r0: number;
  readonly r1: number;
  toPx(value: number): number;
  fromPx(px: number): number;
}

/** Builds a linear scale; a zero-width domain maps everything to the middle of the range. */
export function linearScale(d0: number, d1: number, r0: number, r1: number): LinearScale {
  const span = d1 - d0;
  const k = span === 0 ? 0 : (r1 - r0) / span;
  return {
    d0,
    d1,
    r0,
    r1,
    toPx: (value) => (span === 0 ? (r0 + r1) / 2 : r0 + (value - d0) * k),
    fromPx: (px) => (k === 0 ? d0 : d0 + (px - r0) / k),
  };
}

/**
 * A price range (in ticks) that holds every finite value with `padFraction` of headroom on each side and at least
 * `minSpan` ticks; null when there is no finite value.
 */
export function fitRange(
  values: Iterable<number | null | undefined>,
  padFraction = 0.06,
  minSpan = 8,
): { readonly low: number; readonly high: number } | null {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value !== null && value !== undefined && Number.isFinite(value)) {
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
  }
  if (low > high) {
    return null;
  }
  const span = Math.max(high - low, minSpan);
  const mid = (low + high) / 2;
  const half = (span / 2) * (1 + padFraction * 2);
  return { low: mid - half, high: mid + half };
}

/**
 * Shifts a price window by `deltaTicks` (positive shows higher prices, so a downward drag follows the pointer)
 * and keeps at least a sliver of `[dataLow, dataHigh]` inside the window. The span is unchanged.
 */
export function panPriceRange(
  low: number,
  high: number,
  deltaTicks: number,
  dataLow: number,
  dataHigh: number,
): { readonly low: number; readonly high: number } {
  const span = high - low;
  if (!(span > 0) || !Number.isFinite(span)) {
    return { low, high };
  }
  const shift = Number.isFinite(deltaTicks) ? deltaTicks : 0;
  let nextLow = low + shift;
  let nextHigh = high + shift;
  if (!Number.isFinite(dataLow) || !Number.isFinite(dataHigh) || dataHigh < dataLow) {
    return { low: nextLow, high: nextHigh };
  }
  const sliver = Math.min(1, span);
  if (nextHigh < dataLow + sliver) {
    nextHigh = dataLow + sliver;
    nextLow = nextHigh - span;
  }
  if (nextLow > dataHigh - sliver) {
    nextLow = dataHigh - sliver;
    nextHigh = nextLow + span;
  }
  return { low: nextLow, high: nextHigh };
}

/** Scales a range about its middle: factor < 1 zooms in. */
export function zoomRange(low: number, high: number, factor: number): { readonly low: number; readonly high: number } {
  const mid = (low + high) / 2;
  const half = ((high - low) / 2) * factor;
  return { low: mid - half, high: mid + half };
}

/** About `count` round axis steps across [low, high]: 1, 2 or 5 × a power of ten, at least `minStep`. */
export function niceTicks(low: number, high: number, count: number, minStep = 1): number[] {
  if (!(high > low) || count < 1) {
    return [];
  }
  const raw = (high - low) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? 10 * power;
  const step = Math.max(minStep, unit);
  const ticks: number[] = [];
  for (let v = Math.ceil(low / step) * step; v <= high; v += step) {
    ticks.push(Math.round(v * 1e6) / 1e6);
  }
  return ticks;
}

/** Round time-axis steps, in ms. */
const timeSteps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map((s) => s * 1000);

/** Time-axis marks across [startMs, endMs] at a step that leaves at least `minPx` pixels between labels. */
export function timeTicks(startMs: number, endMs: number, widthPx: number, minPx = 80): number[] {
  if (!(endMs > startMs) || widthPx <= 0) {
    return [];
  }
  const msPerPx = (endMs - startMs) / widthPx;
  const step = timeSteps.find((s) => s / msPerPx >= minPx) ?? 3_600_000;
  const ticks: number[] = [];
  for (let t = Math.ceil(startMs / step) * step; t <= endMs; t += step) {
    ticks.push(t);
  }
  return ticks;
}

import { rgbChannels } from "../design/color.ts";
import { color } from "../design/tokens.ts";
import { perTheme } from "../theme.ts";

/**
 * Bookmap-style ramp for resting quantity (REQUIREMENTS.md FR-58). The stops are the active theme's heat-0 … heat-100 tokens:
 * black, blue, yellow, orange, red in Terminal; Light starts at its warm-paper chart ground.
 * Mapping is a view transform: callers pass a copy of the visible quantities and the stored cells stay as they were.
 */

const STOP_TOKENS = [
  [0, "heat-0"],
  [0.25, "heat-25"],
  [0.5, "heat-50"],
  [0.75, "heat-75"],
  [1, "heat-100"],
] as const;

const stops = perTheme((theme): readonly (readonly [number, number, number, number])[] =>
  STOP_TOKENS.map(([at, name]) => [at, ...rgbChannels(color(name, theme))] as const),
);

/** RGB at `t` in 0..1 along the ramp. */
export function bookmapRgb(t: number): readonly [number, number, number] {
  const x = clamp01(t);
  const STOPS = stops();
  let lower = STOPS[0] ?? [0, 0, 0, 0];
  let upper = STOPS[STOPS.length - 1] ?? lower;
  for (let i = 1; i < STOPS.length; i++) {
    const stop = STOPS[i];
    if (!stop) continue;
    if (x <= stop[0]) {
      upper = stop;
      break;
    }
    lower = stop;
  }
  const span = upper[0] - lower[0];
  const mix = span <= 0 ? 0 : (x - lower[0]) / span;
  return [
    Math.round(lower[1] + (upper[1] - lower[1]) * mix),
    Math.round(lower[2] + (upper[2] - lower[2]) * mix),
    Math.round(lower[3] + (upper[3] - lower[3]) * mix),
  ];
}

/** A CSS color for the ramp. `alpha` is the draw-time dim, not a change to the quantity. */
export function bookmapColor(t: number, alpha: number): string {
  const [r, g, b] = bookmapRgb(t);
  const a = Math.min(1, Math.max(0, alpha));
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
}

/**
 * Low and high cutoffs of `values` at the given percentiles. Sorts a copy, so `values` is unchanged
 * (REQUIREMENTS.md FR-58: auto-contrast does not rewrite historical cells).
 */
export function autoContrastDomain(
  values: readonly number[],
  lowPercent: number,
  highPercent: number,
): { readonly low: number; readonly high: number } {
  if (values.length === 0) {
    return { low: 0, high: 1 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return { low: percentile(sorted, lowPercent), high: percentile(sorted, highPercent) };
}

/** Where `value` sits between the cutoffs, clamped to 0..1. A flat domain paints a positive value at the top. */
export function rampT(value: number, low: number, high: number): number {
  if (high <= low) {
    return value > 0 ? 1 : 0;
  }
  return clamp01((value - low) / (high - low));
}

function percentile(sorted: readonly number[], percent: number): number {
  const p = Math.min(100, Math.max(0, percent)) / 100;
  const index = p * (sorted.length - 1);
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  const frac = index - lo;
  return (sorted[lo] ?? 0) * (1 - frac) + (sorted[hi] ?? 0) * frac;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

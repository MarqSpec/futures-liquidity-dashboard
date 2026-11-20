import type { IndicatorSeries } from "./merge.ts";

// reference: REQUIREMENTS.md FR-77 (ARCHITECTURE.md D-63)

/** Height of one price-axis tag, the same 15px the last-price tag takes. */
export const LINE_TAG_HEIGHT = 15;

/** Pixels of rounding slack in the overlap test, far below anything the eye sees. */
const CLASH_EPSILON = 1e-6;

/** A line the price chart draws and the tag that names it at the right edge. */
export interface LineTagSpec {
  /** `vwap`, `vwap+1`, `vwap-2`, or an indicator id such as `ema48`: the colour is looked up from it. */
  readonly key: string;
  readonly text: string;
  /** The line's price at the right edge, in ticks (fractional for VWAP and EMAs). */
  readonly priceTicks: number;
}

/** The EMA's name on the chart, e.g. `EMA48`. */
function emaName(id: string): string {
  return id.replace(/^ema/, "EMA");
}

/** The visible time window and the live edge, in ms. */
export interface LineWindow {
  readonly startMs: number;
  readonly endMs: number;
  readonly serverTimeMs: number;
}

/**
 * The points an EMA's line is drawn through, from one source timeframe before the window to one after, then joined to
 * its developing value at the live edge. The chart draws this path and the tag reads it, so the two cannot disagree on
 * whether a line is visible. Empty when no line is drawn.
 */
export function emaPath(series: IndicatorSeries, window: LineWindow): readonly (readonly [number, number])[] {
  const margin = series.tf * 1000;
  const path: [number, number][] = [];
  for (const point of series.points) {
    const t = point[0];
    const v = point[1];
    if (t === null || t === undefined || v === null || v === undefined || t < window.startMs - margin) continue;
    if (t > window.endMs + margin) break;
    path.push([t, v]);
  }
  const developing = series.dev?.[0];
  if (path.length > 0 && developing !== null && developing !== undefined) path.push([window.serverTimeMs, developing]);
  return path;
}

/**
 * Where an EMA's drawn line meets the window's right edge: the developing value at the live edge, or the line's value
 * at `endMs` (interpolated between its neighbours) when panned back. Null when no segment of the line overlaps the
 * window, which includes a line of fewer than two points: nothing of it is visible then.
 */
export function lineEndTicks(series: IndicatorSeries, window: LineWindow): number | null {
  const path = emaPath(series, window);
  for (let i = path.length - 1; i > 0; i--) {
    const [t1, v1] = path[i] ?? [0, 0];
    const [t0, v0] = path[i - 1] ?? [0, 0];
    if (t1 < window.startMs || t0 > window.endMs) continue;
    if (window.endMs >= t1 || t1 === t0) return v1;
    return v0 + ((v1 - v0) * (window.endMs - t0)) / (t1 - t0);
  }
  return null;
}

/** An EMA's tag; a line still warming up says so (REQUIREMENTS.md FR-17: values are unready until warmup completes). */
export function emaTag(series: IndicatorSeries, window: LineWindow): LineTagSpec | null {
  const priceTicks = lineEndTicks(series, window);
  if (priceTicks === null) return null;
  return { key: series.id, text: `${emaName(series.id)}${series.ready ? "" : " warm"}`, priceTicks };
}

/** The session VWAP's tag and the four bands it draws when it has a spread. */
export function vwapTags(vwap: { readonly vwap?: number | null; readonly stdDev?: number | null }): readonly LineTagSpec[] {
  const centre = vwap.vwap;
  if (centre === null || centre === undefined || !Number.isFinite(centre)) return [];
  const tags: LineTagSpec[] = [{ key: "vwap", text: "VWAP", priceTicks: centre }];
  const spread = vwap.stdDev;
  if (spread !== null && spread !== undefined && Number.isFinite(spread) && spread > 0) {
    for (const band of [1, 2]) {
      tags.push({ key: `vwap+${band}`, text: `VWAP+${band}σ`, priceTicks: centre + band * spread });
      tags.push({ key: `vwap-${band}`, text: `VWAP-${band}σ`, priceTicks: centre - band * spread });
    }
  }
  return tags;
}

/** A tag with the vertical centre it is drawn at, which may sit off its line when tags are stacked. */
export interface PlacedTag extends LineTagSpec {
  readonly y: number;
}

/**
 * Stacks tags so none overlaps another or a fixed tag (the last-price, bid and ask tags): processed top to bottom, each
 * moves down past whatever it touches; one that falls off the bottom is tried upward instead, and one that fits
 * nowhere is dropped. `wanted` is each tag's pixel y; the result is ordered top to bottom.
 */
export function stackLineTags(
  wanted: readonly { readonly tag: LineTagSpec; readonly y: number }[],
  fixed: readonly number[],
  bounds: { readonly top: number; readonly bottom: number },
): readonly PlacedTag[] {
  const half = LINE_TAG_HEIGHT / 2;
  const top = bounds.top + half;
  const bottom = bounds.bottom - half;
  const taken = [...fixed];
  // A tag exactly one height away does not touch. The tolerance absorbs the rounding error of `hit + height - hit`,
  // which on fractional pixels can come out just under the height and re-find the tag just stepped past.
  const clash = (y: number) => taken.find((c) => Math.abs(c - y) < LINE_TAG_HEIGHT - CLASH_EPSILON);
  const placed: PlacedTag[] = [];
  for (const { tag, y } of [...wanted].sort((a, b) => a.y - b.y)) {
    let at = Math.min(bottom, Math.max(top, y));
    // Each step moves `at` past one tag, so more than `taken.length + 1` steps cannot be progress: a backstop.
    for (let hit = clash(at), steps = 0; hit !== undefined && at <= bottom && steps <= taken.length; hit = clash(at), steps++) {
      at = hit + LINE_TAG_HEIGHT;
    }
    if (at > bottom || clash(at) !== undefined) {
      at = Math.min(bottom, Math.max(top, y));
      for (let hit = clash(at), steps = 0; hit !== undefined && at >= top && steps <= taken.length; hit = clash(at), steps++) {
        at = hit - LINE_TAG_HEIGHT;
      }
      if (at < top || clash(at) !== undefined) continue;
    }
    taken.push(at);
    placed.push({ ...tag, y: at });
  }
  return placed;
}

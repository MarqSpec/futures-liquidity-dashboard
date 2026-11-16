/** The visible time window and price zoom of the time-aligned panes. */
export interface ViewWindow {
  /** How much time the panes show. */
  readonly spanMs: number;
  /** How far the right edge sits behind the live edge; 0 follows live. */
  readonly offsetMs: number;
  /** Price-axis zoom about the fitted range: < 1 zooms in. */
  readonly priceZoom: number;
}

/** How far the right edge sits ahead of the clock while the view follows live. Bookmap and the time-zoom anchor share it. */
export const LIVE_EDGE_PAD = 0.04;

/** The narrowest time span the panes zoom to. */
export const MIN_SPAN_MS = 60_000;

/** Price zoom stops here. A stored value past either end makes the next wheel notch do nothing (REQUIREMENTS.md FR-67). */
export const MIN_PRICE_ZOOM = 0.05;
export const MAX_PRICE_ZOOM = 20;

/** The default window for `historyMinutes` of loaded history: all of it, following live. */
export function defaultWindow(historyMinutes: number): ViewWindow {
  return { spanMs: historyMinutes * 60_000, offsetMs: 0, priceZoom: 1 };
}

/** Clamps price zoom into [MIN_PRICE_ZOOM, MAX_PRICE_ZOOM]. A non-finite value is the fitted zoom, 1. */
export function clampPriceZoom(priceZoom: number): number {
  if (!Number.isFinite(priceZoom)) return 1;
  return Math.min(MAX_PRICE_ZOOM, Math.max(MIN_PRICE_ZOOM, priceZoom));
}

/**
 * The price zoom to store after one wheel or button step. The current value is clamped before the factor, and the
 * product is clamped again, so zooming past a limit does not pile up notches that do nothing on the way back.
 */
export function nextPriceZoom(priceZoom: number, factor: number): number {
  const step = Number.isFinite(factor) && factor > 0 ? factor : 1;
  return clampPriceZoom(clampPriceZoom(priceZoom) * step);
}

/** Clamps a window to the loaded history: the span to [1 min, history], the offset so the window stays inside it. */
export function clampWindow(window: ViewWindow, historyMs: number): ViewWindow {
  const spanMs = Math.min(historyMs, Math.max(MIN_SPAN_MS, window.spanMs));
  const offsetMs = Math.min(historyMs - spanMs, Math.max(0, window.offsetMs));
  return { spanMs, offsetMs, priceZoom: clampPriceZoom(window.priceZoom) };
}

/**
 * Zooms the time span by `factor` while keeping the time at `fractionFromLeft` (0 at the left of the plot) fixed.
 * The span stays inside [1 min, the loaded history], and the offset stays inside that history (REQUIREMENTS.md FR-67).
 */
export function zoomTimeAbout(
  spanMs: number,
  offsetMs: number,
  fractionFromLeft: number,
  factor: number,
  historyMs: number,
): { readonly spanMs: number; readonly offsetMs: number } {
  const current = clampWindow({ spanMs, offsetMs, priceZoom: 1 }, historyMs);
  const step = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const nextSpan = clampWindow({ ...current, spanMs: current.spanMs * step }, historyMs).spanMs;
  const fraction = Number.isFinite(fractionFromLeft) ? Math.min(1, Math.max(0, fractionFromLeft)) : 0.5;
  const rawOffset = current.offsetMs + (nextSpan - current.spanMs) * (fraction - (1 - LIVE_EDGE_PAD));
  const nextOffset = clampWindow({ spanMs: nextSpan, offsetMs: rawOffset, priceZoom: 1 }, historyMs).offsetMs;
  return { spanMs: nextSpan, offsetMs: nextOffset };
}

/**
 * A sideways plot drag. Dragging right looks further back, so the chart follows the pointer.
 * The result cannot move ahead of live or past the start of the loaded history.
 */
export function panOffsetMs(
  startOffsetMs: number,
  dxPx: number,
  spanMs: number,
  plotWidthPx: number,
  historyMs: number,
): number {
  const delta = plotWidthPx > 0 && Number.isFinite(dxPx) ? (dxPx * spanMs) / plotWidthPx : 0;
  return clampWindow({ spanMs, offsetMs: startOffsetMs + delta, priceZoom: 1 }, historyMs).offsetMs;
}

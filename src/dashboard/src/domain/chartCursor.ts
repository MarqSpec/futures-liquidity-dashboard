import type { HeatColumn } from "../api/schemas.ts";
import type { Candle } from "./candles.ts";
import { formatChicagoTime, formatPercent, formatQty, formatTicks, type TickSpec } from "./format.ts";
import { forEachHeatCell } from "./heat.ts";

/** Shown on the chart while it has keyboard focus. Kept short so it does not cover the plot. */
export const chartKeyHint = "←→ bar · ↑↓ price · Shift+←→ pan · +/− zoom · Home live · Esc";

/** Wheel-down / minus. Greater than 1 shows more time or price. */
export const chartZoomOut = 1.15;

/** Wheel-up / plus. */
export const chartZoomIn = 1 / chartZoomOut;

/** Same cell, new numbers: the live region waits this long so a forming bar is not announced on every tick. */
export const readoutRefreshMs = 2000;

/** The keyboard cursor: one bar and one price. */
export interface ChartCursor {
  readonly barT: number;
  readonly priceTicks: number;
}

/** What a key does to the chart. `null` means the key is not a chart key. */
export type ChartKeyAction =
  | { readonly type: "move"; readonly cursor: ChartCursor }
  | { readonly type: "pan"; readonly deltaMs: number }
  | { readonly type: "zoom-time"; readonly factor: number }
  | { readonly type: "zoom-price"; readonly factor: number }
  | { readonly type: "reset" }
  | { readonly type: "dismiss" };

/** The last announcement the live region was given. */
export interface LiveAnnouncement {
  readonly text: string;
  readonly cell: string;
  readonly at: number;
}

const chicagoOffset = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  timeZoneName: "shortOffset",
  hour: "2-digit",
  hour12: false,
});

/** Candles that intersect [startMs, endMs], in time order. */
export function visibleCandles(candles: readonly Candle[], startMs: number, endMs: number): Candle[] {
  return candles.filter((candle) => candle.t + candle.d >= startMs && candle.t <= endMs);
}

/** One tick inside the visible price range. */
export function clampPrice(priceTicks: number, lowTicks: number, highTicks: number): number {
  const low = Math.ceil(lowTicks);
  const high = Math.floor(highTicks);
  if (high < low) return Math.round((lowTicks + highTicks) / 2);
  return Math.min(high, Math.max(low, Math.round(priceTicks)));
}

/** The newest visible bar, at its close. Null when the window has no bar. */
export function initialCursor(
  candles: readonly Candle[],
  startMs: number,
  endMs: number,
  lowTicks: number,
  highTicks: number,
): ChartCursor | null {
  const bar = visibleCandles(candles, startMs, endMs).at(-1);
  if (!bar) return null;
  return { barT: bar.t, priceTicks: clampPrice(bar.c, lowTicks, highTicks) };
}

/** The bar under a pointer time, and the price snapped to a tick. */
export function cursorFromTime(
  candles: readonly Candle[],
  startMs: number,
  endMs: number,
  timeMs: number,
  priceTicks: number,
  lowTicks: number,
  highTicks: number,
): ChartCursor | null {
  const visible = visibleCandles(candles, startMs, endMs);
  if (visible.length === 0) return null;
  let best = visible[0]!;
  let bestDistance = Math.abs(best.t + best.d / 2 - timeMs);
  for (const candle of visible) {
    const distance = Math.abs(candle.t + candle.d / 2 - timeMs);
    if (distance < bestDistance) {
      best = candle;
      bestDistance = distance;
    }
  }
  return { barT: best.t, priceTicks: clampPrice(priceTicks, lowTicks, highTicks) };
}

/**
 * The cursor after the window moves. A bar still in view keeps its place; one that scrolled away snaps to the
 * nearest visible bar. Price stays on a tick inside the range. Null when the window has no bar.
 */
export function clampCursor(
  cursor: ChartCursor,
  candles: readonly Candle[],
  startMs: number,
  endMs: number,
  lowTicks: number,
  highTicks: number,
): ChartCursor | null {
  const visible = visibleCandles(candles, startMs, endMs);
  const bar = visible.find((candle) => candle.t === cursor.barT) ?? visible[nearestIndex(visible, cursor.barT)];
  if (!bar) return null;
  return { barT: bar.t, priceTicks: clampPrice(cursor.priceTicks, lowTicks, highTicks) };
}

/** Pan, zoom, or move the cursor. Shift pans time and zooms price, matching Shift+wheel. */
export function chartKeyAction(
  key: string,
  shiftKey: boolean,
  cursor: ChartCursor,
  candles: readonly Candle[],
  startMs: number,
  endMs: number,
  lowTicks: number,
  highTicks: number,
): ChartKeyAction | null {
  if (key === "Escape") return { type: "dismiss" };
  if (key === "Home") return { type: "reset" };
  if (key === "+" || key === "=") {
    return { type: shiftKey ? "zoom-price" : "zoom-time", factor: chartZoomIn };
  }
  if (key === "-" || key === "_") {
    return { type: shiftKey ? "zoom-price" : "zoom-time", factor: chartZoomOut };
  }
  if (shiftKey && key === "ArrowUp") return { type: "zoom-price", factor: chartZoomIn };
  if (shiftKey && key === "ArrowDown") return { type: "zoom-price", factor: chartZoomOut };
  const barMs = candles.find((candle) => candle.t === cursor.barT)?.d ?? 60_000;
  if (shiftKey && key === "ArrowLeft") return { type: "pan", deltaMs: barMs };
  if (shiftKey && key === "ArrowRight") return { type: "pan", deltaMs: -barMs };
  if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "ArrowUp" && key !== "ArrowDown") return null;

  if (key === "ArrowUp" || key === "ArrowDown") {
    const priceTicks = clampPrice(cursor.priceTicks + (key === "ArrowUp" ? 1 : -1), lowTicks, highTicks);
    if (priceTicks === cursor.priceTicks) return null;
    return { type: "move", cursor: { barT: cursor.barT, priceTicks } };
  }

  const visible = visibleCandles(candles, startMs, endMs);
  if (visible.length === 0) return null;
  const found = visible.findIndex((candle) => candle.t === cursor.barT);
  if (found === -1) {
    const nearest = visible[nearestIndex(visible, cursor.barT)];
    return nearest ? { type: "move", cursor: { barT: nearest.t, priceTicks: cursor.priceTicks } } : null;
  }
  const next = visible[found + (key === "ArrowRight" ? 1 : -1)];
  if (!next) return null;
  return { type: "move", cursor: { barT: next.t, priceTicks: cursor.priceTicks } };
}

/** "UTC-5" / "UTC-6" for the Chicago offset at `ms`. */
export function chicagoUtcOffset(ms: number): string {
  const zone = chicagoOffset.formatToParts(ms).find((part) => part.type === "timeZoneName")?.value ?? "UTC";
  return zone.replace("GMT", "UTC");
}

/**
 * The focused bar's key values (REQUIREMENTS.md FR-7, FR-26): Chicago time and offset, OHLC, executed volume, and the
 * bid/ask time-weighted quantity and coverage at the focused price.
 */
export function focusedBarReadout(input: {
  readonly root: string;
  readonly spec: TickSpec;
  readonly candle: Candle | null;
  readonly priceTicks: number;
  readonly column: HeatColumn | null;
}): string {
  const { root, spec, candle, priceTicks, column } = input;
  if (!candle) return `${root}, no bar in view`;
  const ohlc = [candle.o, candle.h, candle.l, candle.c].map((ticks) => formatTicks(ticks, spec)).join(" / ");
  const cell = heatCell(column, priceTicks);
  const depth = cell
    ? `bid ${formatRawQty(cell.bid)}, ask ${formatRawQty(cell.ask)}, coverage ${formatPercent(cell.knownMs / Math.max(1, column?.d ?? 1))}`
    : "no depth at this price";
  return `${root} ${formatChicagoTime(candle.t)} (${chicagoUtcOffset(candle.t)}), OHLC ${ohlc}, volume ${formatQty(candle.v)}, ${formatTicks(priceTicks, spec)} ${depth}`;
}

/**
 * The text the polite live region should take, or null to keep what it already has. A key press speaks at once.
 * A later change of the same cell waits, so a forming bar does not talk on every tick. The pointer never calls this.
 */
export function nextAnnouncement(
  previous: LiveAnnouncement | null,
  next: LiveAnnouncement & { readonly immediate: boolean },
  minIntervalMs = readoutRefreshMs,
): LiveAnnouncement | null {
  if (!next.text || (previous !== null && previous.text === next.text)) return null;
  if (previous === null || next.immediate || next.at - previous.at >= minIntervalMs) {
    return { text: next.text, cell: next.cell, at: next.at };
  }
  return null;
}

/** `${barT}:${price}` so two cursors on the same cell compare equal. */
export function cursorCellKey(cursor: ChartCursor): string {
  return `${cursor.barT}:${cursor.priceTicks}`;
}

function nearestIndex(candles: readonly Candle[], barT: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index];
    if (!candle) continue;
    const distance = Math.abs(candle.t - barT);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

function heatCell(column: HeatColumn | null, priceTicks: number): { bid: number; ask: number; knownMs: number } | null {
  if (!column) return null;
  let found: { bid: number; ask: number; knownMs: number } | null = null;
  forEachHeatCell(column, (price, bid, ask, knownMs) => {
    if (price === priceTicks) found = { bid, ask, knownMs };
  });
  return found;
}

function formatRawQty(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded)
    ? rounded.toLocaleString("en-US")
    : rounded.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

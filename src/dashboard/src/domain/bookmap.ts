import type { Footprint, Profile } from "../api/schemas.ts";
import { decodeFootprint } from "./footprint.ts";
import type { TickSpec } from "./format.ts";
import { formatLocalTime, formatPercent, formatQty, formatTicks } from "./format.ts";
import { firstColumnEndingAfter } from "./heat.ts";
import type { EventDotSize, HeatMode, LayoutPreset } from "./layout.ts";
import { linearScale, type LinearScale } from "./scale.ts";
import { eventMarker } from "./signals.ts";
import { clampPriceZoom, nextPriceZoom } from "./viewWindow.ts";
import type { TapePrint } from "./volumeDots.ts";

/** Label on the pre-watermark side of the Bookmap tab (REQUIREMENTS.md FR-67, FR-61). */
export const WARMUP_NO_L2 = "history — no L2 / no aggressor";

/** A failed reclaim is inferred. It is not a confirmed stop run and it reads no third-touch flag (REQUIREMENTS.md FR-65). */
export const FAILED_RECLAIM_NOTE = "Inferred from prints and the level. Not a confirmed stop run. Read-only.";

/** Copy beside an order-flow marker on this tab (REQUIREMENTS.md FR-62). */
export const INFERRED_SIGNAL_NOTE = "Inferred from prints and book changes. Read-only. Not an order.";

/** The trail guide never calls a broker (REQUIREMENTS.md FR-66, FR-6). */
export const READ_ONLY_TRAIL = "Read-only trail guide";

export const NOT_AN_ORDER = "Not an order.";

/** How long price has to come back inside a breached level (the sweep window, drawn here, not detected again). */
export const RECLAIM_RETURN_MS = 120_000;

export const BOOKMAP_PRICE_W = 76;
export const BOOKMAP_COB_W = 96;
export const BOOKMAP_SVP_W = 96;
export const BOOKMAP_VOLUME_H = 52;
export const BOOKMAP_CVD_H = 78;

const MIN_RADIUS = 2.5;
const MAX_RADIUS = 10;
const DOT_BUCKET_PX = MAX_RADIUS * 2;
/** A dot this wide or wider prints its quantity; a smaller one cannot hold the label legibly. */
const DOT_LABEL_MIN_DIAMETER = 18;

/** Time width of one dot bucket, wide enough that neighbouring dots do not share a pixel. */
export function sliceBucketMs(spanMs: number, plotWidthPx: number): number {
  return Math.max(1, (Math.max(1, spanMs) / Math.max(1, plotWidthPx)) * DOT_BUCKET_PX);
}

/** Dimming steps on the Bookmap strip. Values are `layout.heatDim`. */
export const heatDimPresets = [
  { label: "0%", value: 0 },
  { label: "25%", value: 0.25 },
  { label: "50%", value: 0.5 },
] as const;

/** Minimum print size on the Bookmap strip. Values are `layout.dotMinQuantity`. This filters volume dots; it does not scale event markers. */
export const dotSizePresets = [
  { label: "All", value: 1 },
  { label: ">= 100", value: 100 },
  { label: ">= 220", value: 220 },
] as const;

/**
 * Drawn radius of an Order Flow event marker. Values are `layout.eventDotSize`.
 * Medium matches the original 4.5 px dot. Large is bigger than the touch minimum so the hit area grows with it.
 */
export const eventDotSizeSteps: readonly { readonly label: string; readonly value: EventDotSize; readonly radius: number }[] = [
  { label: "Small", value: "small", radius: 3 },
  { label: "Medium", value: "medium", radius: 4.5 },
  { label: "Large", value: "large", radius: 14 },
];

/** Smallest pointer target for an event dot, in CSS pixels. A finger still hits a small marker. */
export const EVENT_DOT_HIT_MIN_PX = 12;

/** Drawn radius for a saved event-dot size. An unknown size paints Medium. */
export function eventDotRadius(size: string): number {
  return eventDotSizeSteps.find((step) => step.value === size)?.radius ?? 4.5;
}

/** Pointer target: at least the drawn radius, and at least `EVENT_DOT_HIT_MIN_PX`. */
export function eventHitRadius(size: string): number {
  return Math.max(eventDotRadius(size), EVENT_DOT_HIT_MIN_PX);
}

/** One rectangle in CSS pixels. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The Bookmap canvas: the plot and the dock share one vertical span; the strip and CVD sit under the plot. */
export interface BookmapFrame {
  readonly plot: Box;
  readonly price: Box;
  readonly cob: Box;
  readonly svp: Box;
  readonly volume: Box | null;
  readonly cvd: Box | null;
  readonly cvdBox: Box | null;
}

/**
 * Column widths for the dock. A wide stage keeps the desktop columns. A narrow stage shrinks them so the plot
 * keeps at least 55% of the width (REQUIREMENTS.md FR-67).
 */
export function bookmapDockWidths(stageWidth: number): { readonly price: number; readonly cob: number; readonly svp: number } {
  const full = BOOKMAP_PRICE_W + BOOKMAP_COB_W + BOOKMAP_SVP_W;
  const room = Math.max(1, stageWidth);
  const cap = Math.min(full, Math.floor(room * 0.45));
  if (cap >= full) return { price: BOOKMAP_PRICE_W, cob: BOOKMAP_COB_W, svp: BOOKMAP_SVP_W };
  const dock = Math.max(3, cap);
  const price = Math.max(1, Math.round((BOOKMAP_PRICE_W / full) * dock));
  const cob = Math.max(1, Math.round((BOOKMAP_COB_W / full) * dock));
  const svp = Math.max(1, dock - price - cob);
  return { price, cob, svp };
}

/** Plot, price, COB and SVP share `y` and `h`. The CVD summary sits under that dock. */
export function bookmapFrame(width: number, height: number, options: { readonly volume: boolean; readonly cvd: boolean }): BookmapFrame {
  const dock = bookmapDockWidths(width);
  const dockW = dock.price + dock.cob + dock.svp;
  const plotW = Math.max(1, width - dockW);
  const volumeH = options.volume ? BOOKMAP_VOLUME_H : 0;
  const cvdH = options.cvd ? BOOKMAP_CVD_H : 0;
  const plotH = Math.max(1, height - volumeH - cvdH);
  const price: Box = { x: plotW, y: 0, w: dock.price, h: plotH };
  const cob: Box = { x: plotW + dock.price, y: 0, w: dock.cob, h: plotH };
  const svp: Box = { x: plotW + dock.price + dock.cob, y: 0, w: dock.svp, h: plotH };
  const volume = options.volume ? { x: 0, y: plotH, w: plotW, h: BOOKMAP_VOLUME_H } : null;
  const cvdTop = plotH + volumeH;
  return {
    plot: { x: 0, y: 0, w: plotW, h: plotH },
    price,
    cob,
    svp,
    volume,
    cvd: options.cvd ? { x: 0, y: cvdTop, w: plotW, h: BOOKMAP_CVD_H } : null,
    cvdBox: options.cvd ? { x: plotW, y: cvdTop, w: dockW, h: BOOKMAP_CVD_H } : null,
  };
}

/** Time runs left to right across the plot. Price runs high at the top, and the dock uses that same scale. */
export function bookmapScales(
  frame: BookmapFrame,
  startMs: number,
  endMs: number,
  lowTicks: number,
  highTicks: number,
): { readonly time: LinearScale; readonly price: LinearScale } {
  return {
    time: linearScale(startMs, endMs, frame.plot.x, frame.plot.x + frame.plot.w),
    price: linearScale(highTicks, lowTicks, frame.plot.y, frame.plot.y + frame.plot.h),
  };
}

/** Share of the unshifted span that stays on the plot, so a pan cannot leave a blank canvas (REQUIREMENTS.md FR-67). */
const MIN_ON_SCREEN = 0.15;

/**
 * Caps a vertical pan at about one fitted span, leaving `MIN_ON_SCREEN` of that span on the plot.
 * A non-finite shift or a span that is not positive does not move.
 */
export function clampPriceShift(shiftTicks: number, spanTicks: number): number {
  if (!Number.isFinite(shiftTicks) || !(spanTicks > 0)) return 0;
  const limit = spanTicks * (1 - MIN_ON_SCREEN);
  return Math.min(limit, Math.max(-limit, shiftTicks));
}

/**
 * How a vertical drag on the PRICE axis changes zoom. Dragging up (a negative `dyPx`) stretches the scale;
 * dragging down compresses it. About 90 px is one e-fold (REQUIREMENTS.md FR-67).
 */
export function priceAxisZoomFactor(dyPx: number): number {
  if (!Number.isFinite(dyPx)) return 1;
  return Math.exp(dyPx / 90);
}

/**
 * Zooms price by `factor` while keeping the price at `fractionFromTop` (0 at the top of the plot) fixed.
 * The center is 0.5, which leaves the pan unchanged. The result is clamped, including the pan.
 */
export function zoomPriceAbout(
  priceZoom: number,
  shiftTicks: number,
  fittedSpan: number,
  fractionFromTop: number,
  factor: number,
): { readonly priceZoom: number; readonly shiftTicks: number } {
  const nextZoom = nextPriceZoom(priceZoom, factor);
  const span = Number.isFinite(fittedSpan) && fittedSpan > 0 ? fittedSpan : 0;
  const visibleSpan = span * nextZoom;
  if (span === 0 || !Number.isFinite(fractionFromTop)) {
    return { priceZoom: nextZoom, shiftTicks: clampPriceShift(shiftTicks, visibleSpan) };
  }
  const fraction = Math.min(1, Math.max(0, fractionFromTop));
  const rawShift = shiftTicks + span * (clampPriceZoom(priceZoom) - nextZoom) * (0.5 - fraction);
  return { priceZoom: nextZoom, shiftTicks: clampPriceShift(rawShift, visibleSpan) };
}

/** How often a locked price center steps toward the last trade, so a tick does not move the scale (REQUIREMENTS.md FR-67). */
export const CENTER_FOLLOW_MS = 150;

/** A pinch ignores an axis whose fingers start closer than this, so a vertical pinch does not zoom time (REQUIREMENTS.md FR-67). */
export const PINCH_AXIS_MIN_PX = 32;

/**
 * Vertical pinch travel under this is jitter, not a price zoom, so Lock stays on (REQUIREMENTS.md FR-67).
 * One pixel is inside the band. Two pixels is a price zoom.
 */
export const PINCH_PRICE_DEADBAND_PX = 2;

/** A locked plot drag releases Lock once the pointer has moved this far vertically (REQUIREMENTS.md FR-67). */
export const LOCK_RELEASE_DRAG_PX = 4;

/** The zoom factor for one pinch axis. A start gap under `PINCH_AXIS_MIN_PX` leaves that axis alone. */
export function pinchAxisFactor(startGapPx: number, gapPx: number): number {
  if (!(startGapPx >= PINCH_AXIS_MIN_PX)) return 1;
  const gap = Math.max(1, gapPx);
  return startGapPx / gap;
}

/**
 * The vertical shift that puts `priceTicks` on the midpoint of `range`. Zoom is the range's span and is not changed.
 * The result stays inside the pan bound, so a price far outside the fitted window cannot blank the plot.
 */
export function centerPriceShift(range: { readonly low: number; readonly high: number }, priceTicks: number): number {
  const span = range.high - range.low;
  if (!(span > 0) || !Number.isFinite(priceTicks)) return 0;
  const mid = (range.low + range.high) / 2;
  return clampPriceShift(priceTicks - mid, span);
}

/**
 * One step of a locked center toward `target`. A gap under half a tick snaps, so a quiet last price does not
 * keep rewriting the shift.
 */
export function stepCenterShift(current: number, target: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(target)) return Number.isFinite(current) ? current : 0;
  const delta = target - current;
  if (Math.abs(delta) < 0.5) return target;
  return current + delta * 0.45;
}

/**
 * Moves a price range by `shiftTicks`. A positive shift shows higher prices. The span is unchanged, so price zoom
 * and the vertical pan stay independent (REQUIREMENTS.md FR-67). The shift is capped so part of this range stays visible.
 */
export function shiftPriceRange(
  range: { readonly low: number; readonly high: number },
  shiftTicks: number,
): { readonly low: number; readonly high: number } {
  const span = range.high - range.low;
  const shift = clampPriceShift(shiftTicks, span);
  return { low: range.low + shift, high: range.high + shift };
}

/**
 * Ticks that a vertical drag of `dyPx` moves the price range. Dragging down shows higher prices, so the chart
 * follows the pointer. A plot with no height does not move.
 */
export function dragShiftTicks(
  dyPx: number,
  range: { readonly low: number; readonly high: number },
  plotHeightPx: number,
): number {
  if (!(plotHeightPx > 0) || !Number.isFinite(dyPx)) return 0;
  return (dyPx * (range.high - range.low)) / plotHeightPx;
}

/** The wheel delta that zooms price. Some browsers turn Shift+wheel into a horizontal scroll, so `deltaX` stands in. */
export function priceWheelDelta(event: { readonly deltaX: number; readonly deltaY: number }): number {
  return event.deltaY !== 0 ? event.deltaY : event.deltaX;
}

/** Attaches each row's price to the shared price scale, so COB, SVP and the axis cannot drift apart. */
export function alignPrices<T extends { readonly priceTicks: number }>(
  rows: readonly T[],
  price: LinearScale,
): (T & { readonly y: number })[] {
  return rows.map((row) => ({ ...row, y: price.toPx(row.priceTicks) }));
}

export type CobColumn =
  | { readonly kind: "empty"; readonly label: "depth not subscribed" | "book recovering" }
  | { readonly kind: "book"; readonly levels: readonly { readonly priceTicks: number; readonly bid: number; readonly ask: number }[] };

/**
 * The current book, one row per price. Depth that was never subscribed is not a recovering book
 * (REQUIREMENTS.md FR-54). An unknown book while depth is on is recovering.
 */
export function cobColumn(input: {
  readonly bookKnown: boolean;
  readonly depthSubscribed: boolean;
  readonly bids: readonly (readonly [number, number])[];
  readonly asks: readonly (readonly [number, number])[];
}): CobColumn {
  if (!input.depthSubscribed) return { kind: "empty", label: "depth not subscribed" };
  if (!input.bookKnown) return { kind: "empty", label: "book recovering" };
  const byPrice = new Map<number, { bid: number; ask: number }>();
  for (const [price, qty] of input.bids) {
    const row = byPrice.get(price) ?? { bid: 0, ask: 0 };
    row.bid += qty;
    byPrice.set(price, row);
  }
  for (const [price, qty] of input.asks) {
    const row = byPrice.get(price) ?? { bid: 0, ask: 0 };
    row.ask += qty;
    byPrice.set(price, row);
  }
  const levels = [...byPrice.entries()]
    .map(([priceTicks, size]) => ({ priceTicks, bid: size.bid, ask: size.ask }))
    .sort((a, b) => b.priceTicks - a.priceTicks);
  return { kind: "book", levels };
}

/** One price of the session profile: sell aggressor, buy aggressor, and volume with no side. */
export interface SvpLevel {
  readonly priceTicks: number;
  readonly bid: number;
  readonly ask: number;
  readonly unsided: number;
}

/**
 * Session volume split by aggressor from footprints. When `bounds` is set, only a footprint after the watermark
 * and at or after the session open is buy/sell; warmup, prior-session, and gap-repaired (`approximate`) volume stay unsided (REQUIREMENTS.md FR-61, FR-67, D-33).
 * With no bounds, every footprint is split, which is what the unit fixture without a session clock asserts.
 */
export function sessionVolumeSplit(
  footprints: readonly (Pick<Footprint, "c"> & { readonly t?: number; readonly approximate?: boolean })[],
  bins: readonly (readonly [number, number])[],
  bounds?: { readonly historyWatermarkMs: number | null; readonly sessionOpenMs: number | null },
): SvpLevel[] {
  const byPrice = new Map<number, { bid: number; ask: number }>();
  for (const bar of footprints) {
    if (!footprintIsLiveSplit(bar, bounds)) continue;
    for (const cell of decodeFootprint(bar as Footprint)) {
      const row = byPrice.get(cell.priceTicks) ?? { bid: 0, ask: 0 };
      row.bid += cell.bid;
      row.ask += cell.ask;
      byPrice.set(cell.priceTicks, row);
    }
  }
  const unsided = new Map<number, number>();
  for (const [price, volume] of bins) {
    const split = byPrice.get(price);
    const sided = split ? split.bid + split.ask : 0;
    const rest = volume - sided;
    if (rest > 0) unsided.set(price, rest);
    if (!split && volume > 0) byPrice.set(price, { bid: 0, ask: 0 });
  }
  const prices = new Set<number>([...byPrice.keys(), ...unsided.keys()]);
  return [...prices]
    .map((priceTicks) => {
      const split = byPrice.get(priceTicks) ?? { bid: 0, ask: 0 };
      return { priceTicks, bid: split.bid, ask: split.ask, unsided: unsided.get(priceTicks) ?? 0 };
    })
    .filter((row) => row.bid + row.ask + row.unsided > 0)
    .sort((a, b) => b.priceTicks - a.priceTicks);
}

/** A repaired or undated footprint is not live aggressor flow. With no session bound, every other footprint is split. */
function footprintIsLiveSplit(
  bar: { readonly t?: number; readonly approximate?: boolean },
  bounds: { readonly historyWatermarkMs: number | null; readonly sessionOpenMs: number | null } | undefined,
): boolean {
  if (bar.approximate) return false;
  if (bounds === undefined) return true;
  if (bar.t === undefined) return false;
  if (bounds.historyWatermarkMs !== null && bar.t <= bounds.historyWatermarkMs) return false;
  if (bounds.sessionOpenMs !== null && bar.t < bounds.sessionOpenMs) return false;
  return true;
}

/** Alpha for one ramp bucket. Dimming fades the paint and leaves the quantity alone (REQUIREMENTS.md FR-58). */
export function heatLevelAlpha(levelIndex: number, levelCount: number, dim: number): number {
  const count = Math.max(1, levelCount);
  const base = 0.15 + (0.85 * (levelIndex + 1)) / count;
  const fade = Math.min(1, Math.max(0, dim));
  return base * (1 - fade * 0.85);
}

/** Change in resting size against the previous column. The first column is not treated as new size. */
export function flowDelta(current: number, previous: number | undefined): number {
  if (previous === undefined) return 0;
  return current - previous;
}

/** One Bookmap dot: both aggressors of a time×price bucket, sitting on that bucket's VWAP. */
export interface SliceDot {
  readonly timeMs: number;
  readonly priceTicks: number;
  readonly buy: number;
  readonly sell: number;
  readonly total: number;
  readonly buyFraction: number;
  readonly radius: number;
  readonly label: boolean;
}

/**
 * Live prints after the watermark, grouped by time and price. Buy (`Bid`) and sell (`Ask`) share one dot.
 * A print at the watermark is not a dot (REQUIREMENTS.md FR-61).
 */
export function sliceVolumeDots(input: {
  readonly prints: readonly TapePrint[];
  readonly historyWatermarkMs: number | null;
  readonly startMs: number;
  readonly endMs: number;
  readonly plotWidthPx: number;
  readonly priceSpanTicks: number;
  readonly plotHeightPx: number;
  readonly minQuantity: number;
}): SliceDot[] {
  const bucketMs = sliceBucketMs(input.endMs - input.startMs, input.plotWidthPx);
  const bucketTicks = Math.max(1, Math.round(Math.max(1, input.priceSpanTicks) / Math.max(1, input.plotHeightPx)));
  const groups = new Map<string, { buy: number; sell: number; price: number; time: number }>();
  for (const print of input.prints) {
    if (input.historyWatermarkMs !== null && print.sourceTimeMs <= input.historyWatermarkMs) continue;
    if (print.quantity < input.minQuantity) continue;
    if (print.sourceTimeMs < input.startMs || print.sourceTimeMs > input.endMs) continue;
    const side = print.aggressor === "Bid" ? "buy" : print.aggressor === "Ask" ? "sell" : null;
    if (side === null) continue;
    const key = `${Math.floor(print.sourceTimeMs / bucketMs)}|${Math.floor(print.priceTicks / bucketTicks)}`;
    const acc = groups.get(key) ?? { buy: 0, sell: 0, price: 0, time: 0 };
    acc[side] += print.quantity;
    acc.price += print.priceTicks * print.quantity;
    acc.time += print.sourceTimeMs * print.quantity;
    groups.set(key, acc);
  }
  let maxQty = 1;
  for (const acc of groups.values()) maxQty = Math.max(maxQty, acc.buy + acc.sell);
  const denom = Math.log1p(maxQty);
  const dots: SliceDot[] = [];
  for (const acc of groups.values()) {
    const total = acc.buy + acc.sell;
    if (total <= 0) continue;
    // Quantity sets this radius. `eventDotSize` scales event markers only.
    const radius = MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * (Math.log1p(total) / denom);
    dots.push({
      timeMs: acc.time / total,
      priceTicks: acc.price / total,
      buy: acc.buy,
      sell: acc.sell,
      total,
      buyFraction: acc.buy / total,
      radius,
      label: radius * 2 >= DOT_LABEL_MIN_DIAMETER,
    });
  }
  dots.sort((a, b) => a.timeMs - b.timeMs || a.priceTicks - b.priceTicks);
  return dots;
}

export interface VolumeStripBar {
  readonly t: number;
  readonly d: number;
  readonly buy: number;
  readonly sell: number;
  readonly warmup: boolean;
}

/** Bottom strip. A bar that starts at or before the watermark is warmup and is not painted as aggressor flow. */
export function volumeStripBars(
  bars: readonly { readonly t: number; readonly d: number; readonly bv: number; readonly sv: number }[],
  historyWatermarkMs: number | null,
): VolumeStripBar[] {
  return bars.map((bar) => ({
    t: bar.t,
    d: bar.d,
    buy: bar.bv,
    sell: bar.sv,
    warmup: historyWatermarkMs !== null && bar.t <= historyWatermarkMs,
  }));
}

export interface FailedReclaim {
  readonly name: string;
  readonly levelTicks: number;
  readonly timeMs: number;
  readonly priceTicks: number;
  readonly extremeTicks: number;
  readonly isHigh: boolean;
}

/** Extremes a failed reclaim may watch. Developing session extremes and undated swings flicker, and VAH/VAL move with the profile (REQUIREMENTS.md FR-65). */
const RECLAIM_EXTREMES = new Set([
  "PDH",
  "PDL",
  "Asia high",
  "Asia low",
  "prior week high",
  "prior session high",
  "prior session low",
]);

/**
 * A named extreme that trades at least one tick beyond and comes back within `windowMs`.
 * `isThirdTouch` is not an input (REQUIREMENTS.md FR-65). A print at or before the watermark, or at or before the level's
 * `asOfMs`, cannot open or close one. Once the window expires while price is still beyond, that breach cannot be
 * marked; price has to come back inside before a new breach can start. The extreme keeps running while it is beyond.
 */
export function failedReclaims(input: {
  readonly levels: readonly { readonly name: string; readonly priceTicks: number; readonly isHigh: boolean; readonly asOfMs?: number | null }[];
  readonly prints: readonly { readonly sourceTimeMs: number; readonly priceTicks: number }[];
  readonly historyWatermarkMs: number | null;
  readonly windowMs?: number;
}): FailedReclaim[] {
  const windowMs = input.windowMs ?? RECLAIM_RETURN_MS;
  const livePrints = input.prints
    .filter((print) => input.historyWatermarkMs === null || print.sourceTimeMs > input.historyWatermarkMs)
    .slice()
    .sort((a, b) => a.sourceTimeMs - b.sourceTimeMs);
  const found: FailedReclaim[] = [];
  for (const level of input.levels) {
    if (!RECLAIM_EXTREMES.has(level.name)) continue;
    const asOfMs = level.asOfMs;
    const prints = asOfMs == null ? livePrints : livePrints.filter((print) => print.sourceTimeMs > asOfMs);
    let breachedAt: number | null = null;
    let expired = false;
    let extreme = level.priceTicks;
    for (const print of prints) {
      const beyond = level.isHigh ? print.priceTicks > level.priceTicks : print.priceTicks < level.priceTicks;
      const inside = level.isHigh ? print.priceTicks <= level.priceTicks : print.priceTicks >= level.priceTicks;
      if (breachedAt === null) {
        if (beyond) {
          breachedAt = print.sourceTimeMs;
          extreme = print.priceTicks;
          expired = false;
        }
        continue;
      }
      if (!expired && print.sourceTimeMs - breachedAt > windowMs) expired = true;
      if (level.isHigh ? print.priceTicks > extreme : print.priceTicks < extreme) extreme = print.priceTicks;
      if (expired) {
        if (inside) {
          breachedAt = null;
          expired = false;
        }
        continue;
      }
      if (inside) {
        found.push({
          name: level.name,
          levelTicks: level.priceTicks,
          timeMs: print.sourceTimeMs,
          priceTicks: print.priceTicks,
          extremeTicks: extreme,
          isHigh: level.isHigh,
        });
        breachedAt = null;
        continue;
      }
    }
  }
  return found.sort((a, b) => a.timeMs - b.timeMs || a.levelTicks - b.levelTicks);
}

/** The newest reclaim whose marker is still inside the visible window. One that has scrolled off does not keep a guide. */
export function guideReclaim(reclaims: readonly FailedReclaim[], startMs: number, endMs: number): FailedReclaim | null {
  for (let index = reclaims.length - 1; index >= 0; index--) {
    const reclaim = reclaims[index];
    if (reclaim && reclaim.timeMs >= startMs && reclaim.timeMs <= endMs) return reclaim;
  }
  return null;
}

/** Integer midpoint of the broken level and the furthest print beyond it, toward the lower tick. */
export function brokenMidpoint(levelTicks: number, extremeTicks: number): number {
  return Math.floor((levelTicks + extremeTicks) / 2);
}

export interface TrailGuide {
  readonly fromTicks: number;
  readonly toTicks: number;
  readonly targetName: string;
  readonly heading: typeof READ_ONLY_TRAIL;
  readonly detail: string;
}

/**
 * A guide from the broken midpoint toward the nearest LVN on the side price returned to, else POC, else the
 * next named level. No reclaim, or no level on the return side, means no guide. The text is a reading, not an order (REQUIREMENTS.md FR-66).
 */
export function readOnlyTrailGuide(input: {
  readonly reclaim: FailedReclaim | null;
  readonly poc: number | null;
  readonly lvn: readonly number[];
  readonly levels: readonly { readonly name: string; readonly priceTicks: number }[];
}): TrailGuide | null {
  const reclaim = input.reclaim;
  if (reclaim === null) return null;
  const fromTicks = brokenMidpoint(reclaim.levelTicks, reclaim.extremeTicks);
  const downward = reclaim.isHigh;
  const beyond = (ticks: number) => (downward ? ticks < fromTicks : ticks > fromTicks);
  const nearest = (rows: readonly { readonly ticks: number; readonly name: string }[]) => {
    const pool = rows.filter((row) => beyond(row.ticks));
    pool.sort((a, b) => Math.abs(a.ticks - fromTicks) - Math.abs(b.ticks - fromTicks));
    return pool[0] ?? null;
  };
  const lvn = nearest(input.lvn.map((ticks) => ({ ticks, name: "LVN" })));
  const poc = input.poc !== null && beyond(input.poc) ? { ticks: input.poc, name: "POC" } : null;
  const named = nearest(
    input.levels
      .filter((level) => !(level.name === reclaim.name && level.priceTicks === reclaim.levelTicks))
      .map((level) => ({ ticks: level.priceTicks, name: level.name })),
  );
  const target = lvn ?? poc ?? named;
  if (target === null) return null;
  return {
    fromTicks,
    toTicks: target.ticks,
    targetName: target.name,
    heading: READ_ONLY_TRAIL,
    detail: `${NOT_AN_ORDER} From the broken midpoint toward ${target.name}.`,
  };
}

export interface NamedGuide {
  readonly name: string;
  readonly priceTicks: number;
  readonly emphasis: "level" | "hvn" | "lvn" | "value";
}

const RIPS_LEVELS = new Set(["Asia high", "Asia low", "4h mid", "daily open", "PDH", "PDL", "prior week high", "prior week mid"]);

/** Lines the Bookmap tab names. VAH and VAL are Standard only. HVN and LVN come from the stored profile. */
export function bookmapLevels(input: {
  readonly preset: LayoutPreset;
  readonly hideValueArea: boolean;
  readonly keyLevels: readonly { readonly name: string; readonly priceTicks: number }[];
  readonly profile: Pick<Profile, "poc" | "vah" | "val" | "hvn" | "lvn"> | null;
  readonly vwapTicks: number | null;
}): NamedGuide[] {
  const guides: NamedGuide[] = [];
  for (const level of input.keyLevels) {
    if (RIPS_LEVELS.has(level.name)) guides.push({ name: level.name, priceTicks: level.priceTicks, emphasis: "level" });
  }
  if (input.vwapTicks !== null && Number.isFinite(input.vwapTicks)) {
    guides.push({ name: "VWAP", priceTicks: input.vwapTicks, emphasis: "level" });
  }
  const profile = input.profile;
  if (profile) {
    if (profile.poc != null) guides.push({ name: "POC", priceTicks: profile.poc, emphasis: "level" });
    if (input.preset === "standard" && !input.hideValueArea) {
      if (profile.vah != null) guides.push({ name: "VAH", priceTicks: profile.vah, emphasis: "value" });
      if (profile.val != null) guides.push({ name: "VAL", priceTicks: profile.val, emphasis: "value" });
    }
    for (const ticks of profile.hvn) guides.push({ name: "HVN", priceTicks: ticks, emphasis: "hvn" });
    for (const ticks of profile.lvn) guides.push({ name: "LVN", priceTicks: ticks, emphasis: "lvn" });
  }
  return guides;
}

export interface LiveCvdSummary {
  readonly cvd: number;
  readonly cvdKnown: boolean;
  readonly lastQuantity: number | null;
  readonly lastPriceTicks: number | null;
  readonly warmup: boolean;
  readonly note: string;
}

/** The summary under the dock. Warmup and an unknown CVD say so; neither invents an aggressor. */
export function liveCvdSummary(input: {
  readonly cvd: number;
  readonly cvdKnown: boolean;
  readonly historyWatermarkMs: number | null;
  readonly lastPrint: { readonly sourceTimeMs: number; readonly priceTicks: number; readonly quantity: number } | null;
}): LiveCvdSummary {
  const last = input.lastPrint;
  const warmup = input.historyWatermarkMs !== null && (last === null || last.sourceTimeMs <= input.historyWatermarkMs);
  const note = !input.cvdKnown ? "CVD unknown" : warmup ? WARMUP_NO_L2 : "live";
  return {
    cvd: input.cvd,
    cvdKnown: input.cvdKnown,
    lastQuantity: last?.quantity ?? null,
    lastPriceTicks: last?.priceTicks ?? null,
    warmup,
    note,
  };
}

/** A detected event under the pointer. Level lines are not events. */
export interface ChartEvent {
  readonly kind: string;
  readonly name: string;
  readonly inferred: boolean;
  readonly timeMs: number;
  readonly priceTicks: number;
  readonly priceHighTicks?: number;
  readonly bias?: string;
  readonly strength?: number;
  readonly detail?: string;
  readonly side?: string;
  readonly quantity?: number;
  readonly refills?: number;
  readonly durationMs?: number;
  readonly hiddenEstimate?: number;
  readonly confidence?: number;
}

/** Lines for the tooltip beside an event dot. The name is first; inferred and confirmed stay distinct. */
export function eventTooltipLines(event: ChartEvent, spec: TickSpec): readonly string[] {
  const marker = eventMarker(event.kind);
  const lines = [
    event.name || marker.name,
    event.inferred ? "Inferred" : "Confirmed",
    formatLocalTime(event.timeMs),
    formatTicks(event.priceTicks, spec),
  ];
  if (event.priceHighTicks != null && event.priceHighTicks !== event.priceTicks) {
    lines.push(`through ${formatTicks(event.priceHighTicks, spec)}`);
  }
  if (event.bias) lines.push(event.bias);
  if (event.side) lines.push(event.side);
  if (event.quantity != null) lines.push(`size ${formatQty(event.quantity)}`);
  if (event.refills != null) lines.push(`${event.refills} refills`);
  if (event.durationMs != null) lines.push(`${(event.durationMs / 1000).toFixed(1)} s`);
  if (event.hiddenEstimate != null) lines.push(`hidden ${formatQty(event.hiddenEstimate)}`);
  if (event.confidence != null) lines.push(`confidence ${formatPercent(event.confidence)}`);
  if (event.strength != null && Number.isFinite(event.strength)) lines.push(`strength ${formatPercent(event.strength)}`);
  if (event.detail) lines.push(event.detail);
  return lines;
}

/**
 * The event whose marker is within `radiusPx` of the pointer, nearest first.
 * Leaving that radius dismisses it.
 */
export function eventUnderPointer<T extends { readonly timeMs: number; readonly priceTicks: number }>(
  events: readonly T[],
  x: number,
  y: number,
  toPx: (event: T) => { readonly x: number; readonly y: number },
  radiusPx = 8,
): T | null {
  let best: T | null = null;
  let bestDistance = radiusPx;
  for (const event of events) {
    const point = toPx(event);
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance <= bestDistance) {
      best = event;
      bestDistance = distance;
    }
  }
  return best;
}

/** Keeps a tooltip box inside the plot. */
export function tooltipBox(
  anchorX: number,
  anchorY: number,
  plot: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
  boxWidth = 220,
  boxHeight = 132,
): { readonly left: number; readonly top: number } {
  let left = anchorX + 12;
  let top = anchorY - 8;
  if (left + boxWidth > plot.x + plot.w) left = anchorX - boxWidth - 12;
  if (left < plot.x) left = plot.x + 4;
  if (top + boxHeight > plot.y + plot.h) top = Math.max(plot.y + 4, plot.y + plot.h - boxHeight - 4);
  if (top < plot.y) top = plot.y + 4;
  return { left, top };
}

/** One corner of the last-price step. `breakBefore` starts a new stroke, so a hole is not drawn as a flat market. */
export interface PriceStep {
  readonly timeMs: number;
  readonly priceTicks: number;
  readonly breakBefore?: boolean;
}

/**
 * A quiet stretch is not a hole. `aggregateCandles` omits a minute with no trades, and the last price still holds.
 * A stroke breaks only for a feed hole (`missingRanges`, D-33) or where the gap crosses `sessionOpenMs`. A duration
 * cutoff would cut a thin product that simply does not trade (REQUIREMENTS.md FR-69).
 */
export function priceGapIsHole(
  previousEndMs: number,
  nextStartMs: number,
  holes?: {
    readonly missingRanges?: readonly (readonly [number, number | null | undefined])[];
    readonly sessionOpenMs?: number | null;
  },
): boolean {
  if (!(nextStartMs > previousEndMs) || holes === undefined) return false;
  const sessionOpenMs = holes.sessionOpenMs ?? null;
  if (sessionOpenMs !== null && previousEndMs < sessionOpenMs && nextStartMs >= sessionOpenMs) return true;
  for (const range of holes.missingRanges ?? []) {
    const since = range[0];
    const until = range[1] ?? Number.POSITIVE_INFINITY;
    if (since < nextStartMs && until > previousEndMs) return true;
  }
  return false;
}

/**
 * A step of last traded price from `startMs` up to `nowMs` (and not past `endMs`). A closed bar steps to its close
 * at the bar's end. The bar that contains `nowMs` steps to its close at the last print, or at `nowMs` when that
 * print is missing, and the line stops there instead of running into the live-edge pad. A missing minute holds the
 * last trade. A feed hole or a session open breaks the stroke, and the readout has no price inside it. Each pixel
 * column keeps its first sample, its minimum, its maximum and its last price, so the line starts on time and a
 * spike survives a long range. The result does not depend on the price pan (REQUIREMENTS.md FR-69).
 */
export function lastPriceSteps(
  candles: readonly { readonly t: number; readonly d: number; readonly o: number; readonly c: number }[],
  startMs: number,
  endMs: number,
  plotWidthPx: number,
  nowMs: number,
  lastPrintMs: number | null = null,
  holes?: {
    readonly missingRanges?: readonly (readonly [number, number | null | undefined])[];
    readonly sessionOpenMs?: number | null;
  },
): PriceStep[] {
  if (!(endMs > startMs) || candles.length === 0 || !Number.isFinite(nowMs)) return [];
  const stopMs = Math.min(endMs, nowMs);
  if (!(stopMs > startMs)) return [];
  const raw: PriceStep[] = [];
  let held: number | null = null;
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const candle of candles) {
    if (!(candle.d > 0) || !Number.isFinite(candle.c) || !Number.isFinite(candle.o)) continue;
    const barEnd = candle.t + candle.d;
    if (barEnd <= startMs) {
      held = candle.c;
      previousEnd = barEnd;
      continue;
    }
    if (candle.t >= stopMs) break;
    const gap = raw.length > 0 && priceGapIsHole(previousEnd, candle.t, holes);
    if (raw.length === 0 || candle.t > previousEnd) {
      raw.push({
        timeMs: Math.max(startMs, candle.t),
        priceTicks: candle.t >= startMs ? candle.o : (held ?? candle.o),
        ...(gap ? { breakBefore: true } : {}),
      });
    }
    const forming = barEnd > nowMs;
    const tradedAt =
      lastPrintMs !== null && lastPrintMs > Math.max(candle.t, startMs) && lastPrintMs <= nowMs ? lastPrintMs : nowMs;
    const stepAt = forming ? Math.min(stopMs, tradedAt) : Math.min(stopMs, barEnd);
    const last = raw[raw.length - 1];
    if (last && stepAt > last.timeMs) raw.push({ timeMs: stepAt, priceTicks: candle.c });
    else if (last) raw[raw.length - 1] = { timeMs: stepAt, priceTicks: candle.c, ...(last.breakBefore ? { breakBefore: true } : {}) };
    if (forming) {
      const tail = raw[raw.length - 1];
      if (tail && stopMs > tail.timeMs) raw.push({ timeMs: stopMs, priceTicks: candle.c });
    }
    held = candle.c;
    previousEnd = barEnd;
  }
  const tail = raw[raw.length - 1];
  if (tail && previousEnd <= nowMs && tail.timeMs < stopMs) raw.push({ timeMs: stopMs, priceTicks: tail.priceTicks });
  return decimatePriceSteps(raw, startMs, endMs, plotWidthPx);
}

/** The last price in force at `timeMs`. Null inside a hole, before the line, and after it has stopped. */
export function priceAt(steps: readonly PriceStep[], timeMs: number): number | null {
  const segments = priceSegments(steps);
  for (const run of segments) {
    const first = run[0];
    const last = run[run.length - 1];
    if (!first || !last || timeMs < first.timeMs || timeMs > last.timeMs) continue;
    let price = first.priceTicks;
    for (const step of run) {
      if (step.timeMs > timeMs) break;
      price = step.priceTicks;
    }
    return price;
  }
  return null;
}

/** Pieces of the price line split where a hole starts. */
export function priceSegments(steps: readonly PriceStep[]): PriceStep[][] {
  const segments: PriceStep[][] = [];
  let segment: PriceStep[] = [];
  for (const step of steps) {
    if (step.breakBefore && segment.length > 0) {
      segments.push(segment);
      segment = [];
    }
    segment.push(step);
  }
  if (segment.length > 0) segments.push(segment);
  return segments;
}

/** True when the pointer is within `slackPx` of the last-price step, so the readout can name that price. */
export function pointerOnPriceLine(
  cursorTicks: number,
  lineTicks: number,
  range: { readonly low: number; readonly high: number },
  plotHeightPx: number,
  slackPx = 8,
): boolean {
  const span = range.high - range.low;
  if (!(plotHeightPx > 0) || !(span > 0) || !Number.isFinite(cursorTicks) || !Number.isFinite(lineTicks)) return false;
  return Math.abs(cursorTicks - lineTicks) <= slackPx * (span / plotHeightPx);
}

function decimatePriceSteps(raw: readonly PriceStep[], startMs: number, endMs: number, plotWidthPx: number): PriceStep[] {
  const columns = Math.max(1, Math.floor(Number.isFinite(plotWidthPx) && plotWidthPx > 0 ? plotWidthPx : 1));
  if (raw.length <= columns) return raw.map((step) => ({ ...step }));
  const span = endMs - startMs;
  const bucket = span / columns;
  const bins: PriceStep[][] = Array.from({ length: columns }, () => []);
  for (const point of raw) {
    const col = Math.min(columns - 1, Math.max(0, Math.floor((point.timeMs - startMs) / bucket)));
    bins[col]?.push(point);
  }
  const kept: PriceStep[] = [];
  for (const samples of bins) {
    if (!samples || samples.length === 0) continue;
    let group: PriceStep[] = [];
    const flush = () => {
      if (group.length === 0) return;
      kept.push(...columnExtremes(group));
      group = [];
    };
    for (const sample of samples) {
      if (sample.breakBefore && group.length > 0) flush();
      group.push(sample);
    }
    flush();
  }
  return kept;
}

/** The minimum, the maximum and the last price in one pixel column, in time order, without dropping a spike. */
function columnExtremes(samples: readonly PriceStep[]): PriceStep[] {
  const last = samples[samples.length - 1];
  if (!last) return [];
  let low = samples[0] ?? last;
  let high = low;
  for (const sample of samples) {
    if (sample.priceTicks < low.priceTicks || (sample.priceTicks === low.priceTicks && sample.timeMs < low.timeMs)) low = sample;
    if (sample.priceTicks > high.priceTicks || (sample.priceTicks === high.priceTicks && sample.timeMs < high.timeMs)) high = sample;
  }
  const earliest = samples[0] ?? last;
  const chosen = [earliest, low, high, last].sort((left, right) => left.timeMs - right.timeMs || left.priceTicks - right.priceTicks);
  const unique: PriceStep[] = [];
  for (const point of chosen) {
    const prior = unique[unique.length - 1];
    if (prior && prior.timeMs === point.timeMs && prior.priceTicks === point.priceTicks) continue;
    unique.push(point);
  }
  const gap = samples.some((sample) => sample.breakBefore);
  const first = unique[0];
  if (gap && first && !first.breakBefore) unique[0] = { ...first, breakBefore: true };
  return unique;
}

export interface HoverReadout {
  readonly timeMs: number | null;
  readonly priceText: string;
  readonly bidText: string;
  readonly askText: string;
  readonly sliceText: string;
  /** The live slice under the cursor, split for the readout; null in warmup, off the chart or with no slice. */
  readonly slice: { readonly vwapText: string; readonly buyText: string; readonly sellText: string } | null;
  readonly eventText: string;
  readonly warmup: boolean;
}

/** The strip under the canvas. Resting size is the heatmap column under the cursor, not the live book (REQUIREMENTS.md FR-67). */
export function hoverReadout(input: {
  readonly spec: TickSpec;
  readonly timeMs: number | null;
  readonly priceTicks: number | null;
  readonly historyWatermarkMs: number | null;
  readonly heat: readonly { readonly t: number; readonly d: number; readonly c: readonly number[] }[];
  readonly dots: readonly SliceDot[];
  readonly timeBucketMs: number;
  /** The last-price step under the pointer, when the pointer is on that line. */
  readonly linePriceTicks?: number | null;
}): HoverReadout {
  if (input.timeMs === null || input.priceTicks === null) {
    return {
      timeMs: null,
      priceText: "—",
      bidText: "—",
      askText: "—",
      sliceText: "Hover the chart for time, price, resting size and slice volume.",
      slice: null,
      eventText: "—",
      warmup: false,
    };
  }
  const warmup = input.historyWatermarkMs !== null && input.timeMs <= input.historyWatermarkMs;
  const cursorTick = Math.round(input.priceTicks);
  const priceTick = Math.round(
    input.linePriceTicks != null && Number.isFinite(input.linePriceTicks) ? input.linePriceTicks : input.priceTicks,
  );
  let bidText = "0";
  let askText = "0";
  if (warmup) {
    bidText = WARMUP_NO_L2;
    askText = WARMUP_NO_L2;
  } else {
    const resting = restingAt(input.heat, input.timeMs, cursorTick);
    if (resting === null) {
      bidText = "no resting book";
      askText = "no resting book";
    } else if (!resting.known) {
      // A price the column does not carry is outside the known depth, never a resting size of zero (REQUIREMENTS.md FR-11).
      bidText = resting.absent ? "no depth at this price" : "unknown";
      askText = bidText;
    } else if (resting.coverage < 1) {
      const partial = `partial ${formatPercent(resting.coverage)}`;
      bidText = `${formatQty(resting.bid)} · ${partial}`;
      askText = `${formatQty(resting.ask)} · ${partial}`;
    } else {
      bidText = formatQty(resting.bid);
      askText = formatQty(resting.ask);
    }
  }
  const dot = warmup ? null : nearestDot(input.dots, input.timeMs, input.timeBucketMs);
  const slice = dot
    ? { vwapText: formatTicks(dot.priceTicks, input.spec), buyText: formatQty(dot.buy), sellText: formatQty(dot.sell) }
    : null;
  const sliceText = warmup
    ? WARMUP_NO_L2
    : slice
      ? `slice VWAP ${slice.vwapText} · buy ${slice.buyText} · sell ${slice.sellText}`
      : "no live slice";
  return {
    timeMs: input.timeMs,
    priceText: formatTicks(priceTick, input.spec),
    bidText,
    askText,
    sliceText,
    slice,
    eventText: "—",
    warmup,
  };
}

/**
 * Resting bid and ask in the heatmap column that covers `timeMs`. Null when no column covers that time.
 * A price the column does not carry is unknown (`known: false`, `absent`), never a zero book (REQUIREMENTS.md FR-11).
 * `coverage` is known milliseconds over the slice; below 1 the readout says partial (REQUIREMENTS.md FR-12).
 */
function restingAt(
  columns: readonly { readonly t: number; readonly d: number; readonly c: readonly number[] }[],
  timeMs: number,
  priceTicks: number,
): { readonly bid: number; readonly ask: number; readonly known: boolean; readonly absent: boolean; readonly coverage: number } | null {
  const column = coveringColumn(columns, timeMs);
  if (!column) return null;
  for (let index = 0; index + 3 < column.c.length; index += 4) {
    if ((column.c[index] ?? 0) !== priceTicks) continue;
    const knownMs = column.c[index + 3] ?? 0;
    const coverage = column.d > 0 ? knownMs / column.d : 0;
    return { bid: column.c[index + 1] ?? 0, ask: column.c[index + 2] ?? 0, known: knownMs > 0, absent: false, coverage };
  }
  return { bid: 0, ask: 0, known: false, absent: true, coverage: 0 };
}

/** The newest column that covers `timeMs`. Columns are in time order; the search starts at the first one that ends after it. */
function coveringColumn(
  columns: readonly { readonly t: number; readonly d: number; readonly c: readonly number[] }[],
  timeMs: number,
): { readonly t: number; readonly d: number; readonly c: readonly number[] } | undefined {
  let found: (typeof columns)[number] | undefined;
  for (let index = firstColumnEndingAfter(columns, timeMs); index < columns.length; index++) {
    const item = columns[index];
    if (!item || item.t > timeMs) break;
    if (timeMs >= item.t && timeMs < item.t + item.d) found = item;
  }
  return found;
}

function nearestDot(dots: readonly SliceDot[], timeMs: number, bucketMs: number): SliceDot | null {
  let best: SliceDot | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const dot of dots) {
    const distance = Math.abs(dot.timeMs - timeMs);
    if (distance <= bucketMs && distance < bestDistance) {
      best = dot;
      bestDistance = distance;
    }
  }
  return best;
}

/** Which heat value a cell contributes. Intensity is resting size; flow is the change, and the sign is kept. */
export function heatMetric(mode: HeatMode, resting: number, previous: number | undefined): number {
  return mode === "flow" ? flowDelta(resting, previous) : resting;
}

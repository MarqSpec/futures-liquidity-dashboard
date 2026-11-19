import type { Footprint, RangeZone } from "../api/schemas.ts";
import { composite, mostReadable, withAlpha } from "../design/color.ts";
import { decodeFootprint, footprintPoc, type FootprintCell } from "../domain/footprint.ts";
import { formatLocalMinute, formatQty, formatSigned, formatTicks, type TickSpec } from "../domain/format.ts";
import { linearScale, niceTicks, timeTicks, type LinearScale } from "../domain/scale.ts";
import { labelBox, type Surface } from "../lib/canvas.ts";
import { canvasFonts } from "../lib/canvasFonts.ts";
import { fnvHex, fnvStart, mix, mixNumbers } from "../lib/fnv.ts";
import { AXIS_WIDTH, canvasTheme, colors, fonts, MONO, perTheme, themeColor, themed } from "../theme.ts";
import { TIME_AXIS_HEIGHT, type MainChartGeometry } from "./drawMainChart.ts";
import { drawRangeZones } from "./drawRangeZones.ts";


/** Height of the per-bar delta row between the footprint's plot and its time axis. */
export const FOOTPRINT_DELTA_STRIP = 16;

/** The ground the footprint's cells are shaded over. */
export const FOOTPRINT_GROUND = "surface";

/**
 * Text a split cell may print its volume in: the first while it holds 4.5:1 on the cell's shade, otherwise the most
 * readable. Grey down at 85% left the first at 1.9:1 in Terminal.
 */
export const CELL_TEXT_TOKENS = ["on-surface-variant", "on-surface", "surface-lowest"] as const;

const TEXT_MINIMUM = 4.5;

/** A split cell's shade: 85% on its diagonal imbalance side, otherwise 8% plus up to 40% by its share of the bar. */
export function splitCellAlpha(volume: number, maxVolume: number, imbalanced: boolean): number {
  return imbalanced ? 0.85 : 0.08 + 0.4 * (volume / maxVolume);
}

const groundColour = perTheme((theme) => themeColor(FOOTPRINT_GROUND, theme));

const tints = themed((theme) => ({
  statusWatermark: withAlpha(themeColor("status-simulated", theme), 0.07),
}));

/** Paints the chart's ground: the one colour the cell text is picked against. */
function paintGround(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.fillStyle = groundColour();
  ctx.fillRect(0, 0, width, height);
}

const cellText = perTheme((theme) => {
  const [preferred, ...others] = CELL_TEXT_TOKENS.map((name) => themeColor(name, theme));
  const ground = themeColor(FOOTPRINT_GROUND, theme);
  return (side: string, alpha: number): string =>
    mostReadable(composite(side, alpha, ground), preferred ?? "", others, TEXT_MINIMUM);
});

/** Closed-bar hashes. Bars are not mutated; a correction is a new object, so a cached stamp cannot go stale. */
const barStamp = new WeakMap<Footprint, number>();

/** What the footprint main chart draws. */
export interface FootprintModel {
  readonly startMs: number;
  readonly endMs: number;
  /** The price window, in ticks: the same fit, zoom, pan and Lock as the price chart (REQUIREMENTS.md FR-68). */
  readonly lowTicks: number;
  readonly highTicks: number;
  readonly bars: readonly Footprint[];
  readonly developing: Footprint | null;
  readonly spec: TickSpec;
  /** Dropped-trade holes. A bar that overlaps one is missing, including bars received before the range closed. */
  readonly missingRanges?: readonly (readonly (number | null | undefined)[])[];
  /** Minutes filled from a closed bar. A bar that overlaps one is approximate, even when it also overlaps a hole. */
  readonly approximateRanges?: readonly (readonly (number | null | undefined)[])[];
  /** The last traded price, tagged on the price axis. */
  readonly lastTicks?: number | null;
  /** The provenance word laid faintly across the plot when the feed is not LIVE (REQUIREMENTS.md FR-4). */
  readonly watermark?: string | null;
  /** Range zones shaded over the ground, behind the cells (REQUIREMENTS.md FR-75). */
  readonly rangeZones?: readonly RangeZone[];
}

/** True when the bar overlaps a dropped-trade hole. An open hole has no end. */
export function barOverlapsMissing(
  startMs: number,
  durationMs: number,
  ranges: readonly (readonly (number | null | undefined)[])[],
): boolean {
  const endMs = startMs + durationMs;
  return ranges.some((range) => {
    const since = range[0];
    return since != null && endMs > since && startMs < (range[1] ?? Number.POSITIVE_INFINITY);
  });
}

interface PaintedBar {
  readonly bar: Footprint;
  readonly cells: FootprintCell[];
  readonly developing: boolean;
}

interface FootprintLayout {
  readonly width: number;
  readonly height: number;
  readonly plotWidth: number;
  readonly plotHeight: number;
  readonly rowHeight: number;
  readonly time: LinearScale;
  readonly price: LinearScale;
  readonly closed: readonly PaintedBar[];
  readonly developing: PaintedBar | null;
  readonly showText: boolean;
  readonly model: FootprintModel;
}

interface FootprintCache {
  readonly key: string;
  readonly canvas: HTMLCanvasElement;
}

let footprintCache: FootprintCache | null = null;

/**
 * Closed bars plus the scales, quantised to one pixel of the time window. The developing bar is left out, so a tick
 * that only changes the forming bar reuses the cached columns. Closed cells are mixed, not summed, so two different
 * bars cannot share a key. `fontEpoch` changes once the canvas fonts load, so cached text drawn in the fallback face is
 * not reused; `palette` is the canvas palette, so cells cached in one theme's colours, or before a chart colour
 * changed, are not either.
 */
export function footprintCacheKey(
  model: FootprintModel,
  width: number,
  height: number,
  fontEpoch = canvasFonts.epoch(),
  palette: string = canvasTheme.palette(),
): string {
  const span = Math.max(1, model.endMs - model.startMs);
  const quantum = span / Math.max(1, width);
  let hash = fnvStart();
  hash = mix(hash, [
    width,
    height,
    globalThis.devicePixelRatio || 1,
    fontEpoch,
    palette,
    Math.round(model.startMs / quantum),
    Math.round(model.endMs / quantum),
    model.lowTicks,
    model.highTicks,
    model.spec.tickSize,
    model.spec.priceDecimals,
    model.watermark ?? "",
    // Only whether a forming bar is in view: the title says "no traded bars" without one.
    model.developing && model.developing.t + model.developing.d >= model.startMs && model.developing.t <= model.endMs ? 1 : 0,
    (model.missingRanges ?? []).map((range) => range.join(":")).join(","),
    (model.approximateRanges ?? []).map((range) => range.join(":")).join(","),
    (model.rangeZones ?? []).map((zone) => `${zone.startMs}:${zone.endMs}:${zone.lowTicks}:${zone.highTicks}`).join(","),
  ]);
  let closed = 0;
  for (const bar of model.bars) {
    if (bar.t + bar.d < model.startMs || bar.t > model.endMs) continue;
    closed += 1;
    hash = mix(hash, [stampFootprintBar(bar)]);
  }
  hash = mix(hash, [closed]);
  return fnvHex(hash);
}

/** A hash of everything a bar draws. Cached for a closed bar, which is never mutated. */
export function stampFootprintBar(bar: Footprint): number {
  const cached = barStamp.get(bar);
  if (cached !== undefined) return cached;
  const hash = mixNumbers(mix(fnvStart(), [bar.t, bar.d, bar.delta, bar.v, bar.missing ? 1 : 0, bar.approximate ? 1 : 0]), bar.c);
  barStamp.set(bar, hash);
  return hash;
}

/**
 * Draws Detail's footprint main chart: one column per bar on the shared time axis, and one row per price tick on the
 * same price window the price chart uses, so +, −, Fit, Center, Lock, the drag and the wheel move it the same way
 * (REQUIREMENTS.md FR-41–FR-45, FR-68). Each row shows bid × ask, a diagonal imbalance fills its side, the bar's POC is outlined
 * and the bar delta sits in a row under the plot. Closed columns are cached: a forming bar repaints only its own column.
 */
export function drawFootprint(surface: Surface, model: FootprintModel): MainChartGeometry {
  const layout = layoutOf(surface, model);
  const key = footprintCacheKey(model, surface.width, surface.height);
  const cached = footprintCache?.key === key ? footprintCache.canvas : null;
  if (cached) {
    blit(surface.ctx, cached);
    if (layout.developing) {
      surface.ctx.save();
      clipColumns(surface.ctx, layout);
      drawBars(surface.ctx, [layout.developing], layout);
      surface.ctx.restore();
    }
  } else {
    paintGround(surface.ctx, surface.width, surface.height);
    drawChart(surface.ctx, layout, true);
    remember(key, surface, layout);
  }
  drawLastPrice(surface.ctx, layout);
  return {
    plotLeft: 0,
    plotWidth: layout.plotWidth,
    plotHeight: layout.plotHeight,
    time: layout.time,
    price: layout.price,
    markers: [],
    timeAxisTop: layout.plotHeight + FOOTPRINT_DELTA_STRIP,
  };
}

function layoutOf(surface: Surface, model: FootprintModel): FootprintLayout {
  const plotWidth = Math.max(10, surface.width - AXIS_WIDTH);
  const plotHeight = Math.max(10, surface.height - TIME_AXIS_HEIGHT - FOOTPRINT_DELTA_STRIP);
  const time = linearScale(model.startMs, model.endMs, 0, plotWidth);
  const price = linearScale(model.lowTicks, model.highTicks, plotHeight, 0);
  const all = model.developing ? [...model.bars, model.developing] : model.bars;
  const visible = all.filter((bar) => bar.t + bar.d >= model.startMs && bar.t <= model.endMs);
  const decoded = visible.map((bar) => ({ bar, cells: decodeFootprint(bar), developing: bar === model.developing }));
  const rowHeight = Math.abs(price.toPx(0) - price.toPx(1));
  return {
    width: surface.width,
    height: surface.height,
    plotWidth,
    plotHeight,
    rowHeight,
    time,
    price,
    closed: decoded.filter((entry) => !entry.developing),
    developing: decoded.find((entry) => entry.developing) ?? null,
    showText: rowHeight >= 9,
    model,
  };
}

/** The plot and the delta row under it, both cut at the price axis. */
function clipColumns(ctx: CanvasRenderingContext2D, layout: FootprintLayout): void {
  ctx.beginPath();
  ctx.rect(0, 0, layout.plotWidth, layout.plotHeight + FOOTPRINT_DELTA_STRIP);
  ctx.clip();
}

function drawChart(ctx: CanvasRenderingContext2D, layout: FootprintLayout, includeDeveloping: boolean): void {
  const bars = includeDeveloping && layout.developing ? [...layout.closed, layout.developing] : layout.closed;
  drawWatermark(ctx, layout);
  drawRangeZones(ctx, layout.model.rangeZones ?? [], layout.time, layout.price, { x: 0, y: 0, w: layout.plotWidth, h: layout.plotHeight });
  drawGrid(ctx, layout);
  ctx.save();
  clipColumns(ctx, layout);
  drawBars(ctx, bars, layout);
  ctx.restore();
  drawAxes(ctx, layout);
}

function drawWatermark(ctx: CanvasRenderingContext2D, layout: FootprintLayout): void {
  const text = layout.model.watermark;
  if (!text) return;
  ctx.save();
  ctx.fillStyle = tints.statusWatermark;
  ctx.font = `bold ${Math.max(28, Math.min(72, layout.plotWidth / 10))}px ${MONO}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, layout.plotWidth / 2, layout.plotHeight / 2);
  ctx.restore();
}

function drawGrid(ctx: CanvasRenderingContext2D, layout: FootprintLayout): void {
  const { model, price, time, plotWidth, plotHeight } = layout;
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const p of niceTicks(model.lowTicks, model.highTicks, Math.max(2, Math.floor(plotHeight / 48)))) {
    const y = Math.round(price.toPx(p)) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(plotWidth, y);
  }
  for (const t of timeTicks(model.startMs, model.endMs, plotWidth)) {
    const x = Math.round(time.toPx(t)) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, plotHeight);
  }
  ctx.stroke();
}

function drawBars(ctx: CanvasRenderingContext2D, bars: readonly PaintedBar[], layout: FootprintLayout): void {
  const { model, price, rowHeight } = layout;
  const cellHeight = Math.max(1, rowHeight - (rowHeight > 3 ? 1 : 0));
  for (const { bar, cells, developing } of bars) {
    // A gap between columns only once they are wide enough: over a long window a bar is a pixel or two, and
    // insetting it would leave the plot empty.
    const left = layout.time.toPx(bar.t);
    const right = layout.time.toPx(bar.t + bar.d);
    const inset = right - left >= 6 ? 1 : 0;
    const x0 = left + inset;
    const x1 = Math.max(x0 + 1, right - inset);
    const colWidth = x1 - x0;
    if (right < 0 || left > layout.plotWidth) continue;
    const split = layout.showText && colWidth >= 46;
    const half = colWidth / 2;
    const maxVolume = Math.max(1, ...cells.map((cell) => Math.max(cell.bid, cell.ask)));
    const poc = footprintPoc(cells);
    ctx.font = rowHeight >= 13 ? fonts.sm : fonts.xs;
    ctx.textBaseline = "middle";
    for (const cell of cells) {
      if (cell.priceTicks < model.lowTicks - 1 || cell.priceTicks > model.highTicks + 1) continue;
      const y = price.toPx(cell.priceTicks + 0.5);
      if (split) {
        const sellShade = splitCellAlpha(cell.bid, maxVolume, cell.imbalance === -1);
        const buyShade = splitCellAlpha(cell.ask, maxVolume, cell.imbalance === 1);
        ctx.fillStyle = withAlpha(colors.down, sellShade);
        ctx.fillRect(x0, y, half - 0.5, rowHeight - 1);
        ctx.fillStyle = withAlpha(colors.up, buyShade);
        ctx.fillRect(x0 + half + 0.5, y, half - 0.5, rowHeight - 1);
        ctx.fillStyle = cellText()(colors.down, sellShade);
        ctx.textAlign = "right";
        ctx.fillText(formatQty(cell.bid), x0 + half - 3, y + rowHeight / 2);
        ctx.fillStyle = cellText()(colors.up, buyShade);
        ctx.textAlign = "left";
        ctx.fillText(formatQty(cell.ask), x0 + half + 3, y + rowHeight / 2);
      } else {
        const net = cell.ask - cell.bid;
        const alpha = 0.15 + 0.7 * (Math.abs(net) / maxVolume);
        ctx.fillStyle = withAlpha(net >= 0 ? colors.up : colors.down, alpha);
        ctx.fillRect(x0, y, colWidth, cellHeight);
        if (cell.imbalance !== 0 && rowHeight >= 3) {
          ctx.fillStyle = cell.imbalance === 1 ? colors.up : colors.down;
          ctx.fillRect(cell.imbalance === 1 ? x1 - 3 : x0, y, 3, Math.max(1, rowHeight - 1));
        }
      }
      if (cell.priceTicks === poc) {
        ctx.strokeStyle = colors.poc;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x0 + 0.5, y + 0.5, colWidth - 1, Math.max(1, rowHeight - 2));
      }
    }
    if (developing) {
      ctx.strokeStyle = colors.muted;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(x0 + 0.5, 0.5, colWidth - 1, layout.plotHeight - 1);
      ctx.setLineDash([]);
    }
    drawDelta(ctx, bar, x0, colWidth, layout);
  }
}

function drawDelta(ctx: CanvasRenderingContext2D, bar: Footprint, x0: number, colWidth: number, layout: FootprintLayout): void {
  const top = layout.plotHeight;
  ctx.font = fonts.xs;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = bar.delta >= 0 ? colors.up : colors.down;
  // Ranges are replaced on every delta. A bar the client already holds is not, so the flag comes from the
  // ranges alone: a reload and a browser that has been on deltas then draw the same minutes.
  const approximate = barOverlapsMissing(bar.t, bar.d, layout.model.approximateRanges ?? []);
  const missing = !approximate && barOverlapsMissing(bar.t, bar.d, layout.model.missingRanges ?? []);
  const mark = approximate ? "≈" : missing ? "~" : "";
  const middle = top + FOOTPRINT_DELTA_STRIP / 2;
  if (colWidth >= 22) {
    ctx.fillText(mark.length > 0 ? `${mark} ${formatSigned(bar.delta)}` : formatSigned(bar.delta), x0 + colWidth / 2, middle);
  } else if (mark.length > 0) {
    ctx.fillText(mark, x0 + colWidth / 2, middle);
  } else {
    ctx.fillRect(x0, top + 4, colWidth, FOOTPRINT_DELTA_STRIP - 8);
  }
}

function drawAxes(ctx: CanvasRenderingContext2D, layout: FootprintLayout): void {
  const { model, price, time, plotWidth, plotHeight } = layout;
  ctx.font = fonts.sm;
  ctx.fillStyle = colors.axis;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const p of niceTicks(model.lowTicks, model.highTicks, Math.max(2, Math.floor(plotHeight / 48)))) {
    ctx.fillText(formatTicks(p, model.spec), plotWidth + 6, price.toPx(p));
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const axisTop = plotHeight + FOOTPRINT_DELTA_STRIP;
  for (const t of timeTicks(model.startMs, model.endMs, plotWidth)) {
    ctx.fillText(formatLocalMinute(t), time.toPx(t), axisTop + 5);
  }
  ctx.strokeStyle = colors.grid;
  ctx.strokeRect(0.5, 0.5, plotWidth, plotHeight);
  ctx.beginPath();
  ctx.moveTo(0, axisTop + 0.5);
  ctx.lineTo(plotWidth, axisTop + 0.5);
  ctx.stroke();
  const empty = layout.closed.length === 0 && layout.developing === null;
  ctx.font = fonts.sm;
  labelBox(ctx, empty ? "Footprint — no traded bars in view" : "Footprint (bid × ask, 1 min)", 4, 10, { fill: colors.scrim, color: colors.text });
}

/** The last price's dashed line and its tag on the price axis, drawn over the cached columns so it follows live. */
function drawLastPrice(ctx: CanvasRenderingContext2D, layout: FootprintLayout): void {
  const last = layout.model.lastTicks;
  if (last === null || last === undefined || last < layout.model.lowTicks || last > layout.model.highTicks) return;
  const y = Math.round(layout.price.toPx(last)) + 0.5;
  ctx.strokeStyle = colors.priceTag;
  ctx.setLineDash([2, 3]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(layout.plotWidth, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = fonts.tag;
  labelBox(ctx, formatTicks(last, layout.model.spec), layout.plotWidth + 2, y, { fill: colors.priceTag, color: colors.onPriceTag });
}

function blit(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(canvas, 0, 0);
  ctx.restore();
}

function remember(key: string, surface: Surface, layout: FootprintLayout): void {
  if (typeof document === "undefined") return;
  const ratio = globalThis.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(surface.width * ratio));
  canvas.height = Math.max(1, Math.round(surface.height * ratio));
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  paintGround(ctx, surface.width, surface.height);
  drawChart(ctx, layout, false);
  footprintCache = { key, canvas };
}

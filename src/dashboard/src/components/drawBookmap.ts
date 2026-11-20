import type { HeatColumn, RangeZone } from "../api/schemas.ts";
import type { Candle } from "../domain/candles.ts";
import { withAlpha } from "../design/color.ts";
import { BOOKMAP_STAGE, WARMUP_BAND_ALPHA } from "../design/contrastFloors.ts";
import {
  priceSegments,
  WARMUP_NO_L2,
  type BookmapFrame,
  type CobColumn,
  type FailedReclaim,
  type NamedGuide,
  type PriceStep,
  type SliceDot,
  type SvpLevel,
  type TrailGuide,
  bookmapScales,
  heatLevelAlpha,
  heatMetric,
} from "../domain/bookmap.ts";
import type { TickSpec } from "../domain/format.ts";
import { formatLocalMinute, formatQty, formatTicks } from "../domain/format.ts";
import { firstColumnEndingAfter, forEachHeatCell, logIntensity } from "../domain/heat.ts";
import { autoContrastDomain, bookmapColor, rampT } from "../domain/heatRamp.ts";
import type { HeatMode } from "../domain/layout.ts";
import { niceTicks, timeTicks } from "../domain/scale.ts";
import { eventMarker } from "../domain/signals.ts";
import { THIN_TAPE_ALPHA } from "../domain/tape.ts";
import { labelBox, type Surface } from "../lib/canvas.ts";
import { colors, fonts, orderFlowFonts, themeColor, themed } from "../theme.ts";
import { drawRangeZones } from "./drawRangeZones.ts";
import { strokeVolumeDotOutline } from "./volumeDotOutline.ts";

const HEAT_LEVELS = 8;

// The stage and the warmup band alpha are NFR-8 inputs, so they live with the contrast floors.
export { BOOKMAP_STAGE, WARMUP_BAND_ALPHA };

// Every colour on the Order Flow canvas is a design token, in the active canvas theme, the D-40 price line and its
// halos included, read through the viewer's chart colours.
const palette = themed((theme) => ({
  stage: themeColor(BOOKMAP_STAGE, theme),
  dock: themeColor("surface-low", theme),
  card: themeColor("surface-container", theme),
  strong: themeColor("on-surface", theme),
  text: themeColor("on-surface-variant", theme),
  muted: themeColor("on-surface-muted", theme),
  crosshair: themeColor("crosshair", theme),
  up: themeColor("up", theme),
  down: themeColor("down", theme),
  bid: themeColor("bid", theme),
  ask: themeColor("ask", theme),
  buy: themeColor("aggressor-buy", theme),
  sell: themeColor("aggressor-sell", theme),
  warmup: themeColor("warmup", theme),
  hvn: themeColor("node-hvn", theme),
  lvn: themeColor("node-lvn", theme),
  neutral: themeColor("node-neutral", theme),
  poc: themeColor("poc", theme),
  vwap: themeColor("vwap", theme),
  value: themeColor("value-area", theme),
  dotLabel: themeColor("dot-label", theme),
  dotLabelHalo: themeColor("dot-label-halo", theme),
  guideCaption: themeColor("guide-caption", theme),
  guideFill: themeColor("guide-fill", theme),
  guideText: themeColor("guide-text", theme),
  priceTag: themeColor("price-tag", theme),
  onPriceTag: themeColor("on-price-tag", theme),
  /** The last-price step: light over a dark halo in Terminal, dark over a light halo in Light. */
  priceLine: themeColor("price-line", theme),
  priceLineHalo: themeColor("price-line-halo", theme),
  /** The halo under the dashed warmup stretch of the same step. */
  priceLineHaloWarmup: themeColor("price-line-halo-warmup", theme),
}));

/** label-sm: column heads, set in capitals. */
const LABEL_SM = orderFlowFonts.label;
const DATA_XS = fonts.xs;
const DATA_SM = fonts.sm;
const DOT_LABEL = fonts.mark;
/** Stroke width of the dot label's halo: 1.5px of halo outside each glyph edge. */
const DOT_LABEL_HALO = 3;

/** What one Bookmap frame paints. The geometry is `frame`; the columns use its price scale. */
export interface BookmapDrawModel {
  readonly frame: BookmapFrame;
  readonly startMs: number;
  readonly endMs: number;
  readonly lowTicks: number;
  readonly highTicks: number;
  readonly heatColumns: readonly HeatColumn[];
  readonly heatMode: HeatMode;
  readonly heatDim: number;
  readonly heatContrast: number;
  readonly heatAutoContrast: boolean;
  readonly heatLowPercentile: number;
  readonly heatHighPercentile: number;
  readonly historyWatermarkMs: number | null;
  readonly candles: readonly Candle[];
  readonly showCandles: boolean;
  readonly showPriceLine: boolean;
  readonly priceSteps: readonly PriceStep[];
  readonly eventDotRadius: number;
  readonly dots: readonly SliceDot[];
  readonly levels: readonly NamedGuide[];
  readonly emphasizeNodes: boolean;
  readonly showBbo: boolean;
  readonly bboStale: boolean;
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly showPnc: boolean;
  /** `thinTape` dims the marker (REQUIREMENTS.md FR-83). */
  readonly signals: readonly { readonly timeMs: number; readonly priceTicks: number; readonly kind: string; readonly inferred: boolean; readonly thinTape?: boolean }[];
  readonly reclaims: readonly FailedReclaim[];
  readonly guide: TrailGuide | null;
  readonly cob: CobColumn;
  readonly svp: readonly SvpLevel[];
  readonly spec: TickSpec;
  readonly lastPriceTicks: number | null;
  readonly hover: { readonly timeMs: number; readonly priceTicks: number } | null;
  /** Range zones shaded behind the heat (REQUIREMENTS.md FR-75). */
  readonly rangeZones?: readonly RangeZone[];
}

/** The heat scale one frame painted with, for the legend: its low and high cutoffs, null when no heat is in view. */
export interface BookmapHeatScale {
  readonly low: number;
  readonly high: number;
}

/** Paints the Bookmap prototype. Read-only: the guide and markers are labels, not orders (REQUIREMENTS.md FR-6). */
export function drawBookmap(surface: Surface, model: BookmapDrawModel): BookmapHeatScale | null {
  const { ctx, width, height } = surface;
  const { frame } = model;
  const scales = bookmapScales(frame, model.startMs, model.endMs, model.lowTicks, model.highTicks);
  ctx.fillStyle = palette.stage;
  ctx.fillRect(0, 0, width, height);
  ctx.font = DATA_SM;
  drawRangeZones(ctx, model.rangeZones ?? [], scales.time, scales.price, frame.plot, warmupEdgeX(model, scales));
  const heat = drawHeat(ctx, model, scales);
  drawWarmup(ctx, model, scales);
  if (model.showPriceLine) drawPriceLine(ctx, model, scales);
  if (model.showCandles) drawCandles(ctx, model, scales);
  drawLevels(ctx, model, scales);
  if (model.showBbo) drawBbo(ctx, model, scales);
  drawDots(ctx, model, scales);
  // Detected-event dots are always drawn; the PNC toggle governs only the reclaim markers and the trail guide.
  drawSignals(ctx, model, scales);
  if (model.showPnc) {
    drawReclaims(ctx, model, scales);
    if (model.guide) drawGuide(ctx, model, scales, model.guide);
  }
  drawPriceColumn(ctx, model, scales);
  drawCob(ctx, model, scales);
  drawSvp(ctx, model, scales);
  drawHeaders(ctx, frame);
  if (model.hover) drawHover(ctx, model, scales);
  return heat;
}

function columnTotals(column: HeatColumn): Map<number, number> {
  const totals = new Map<number, number>();
  forEachHeatCell(column, (price, bid, ask) => {
    totals.set(price, bid + ask);
  });
  return totals;
}

function drawHeat(
  ctx: CanvasRenderingContext2D,
  model: BookmapDrawModel,
  scales: ReturnType<typeof bookmapScales>,
): BookmapHeatScale | null {
  const { plot } = model.frame;
  const heat = model.heatColumns;
  const flow = model.heatMode === "flow";
  const samples: number[] = [];
  const added: number[][] = Array.from({ length: HEAT_LEVELS }, () => []);
  const pulled: number[][] = Array.from({ length: HEAT_LEVELS }, () => []);
  const first = firstColumnEndingAfter(heat, model.startMs);
  let previous = first > 0 && heat[first - 1] ? columnTotals(heat[first - 1]!) : new Map<number, number>();
  let maxMetric = 0;
  const metrics = new Map<HeatColumn, Map<number, number>>();
  for (let i = first; i < heat.length; i++) {
    const column = heat[i];
    if (!column || column.t > model.endMs) break;
    const totals = columnTotals(column);
    const metric = new Map<number, number>();
    for (const [price, total] of totals) {
      const value = heatMetric(model.heatMode, total, flow ? previous.get(price) : undefined);
      metric.set(price, value);
      maxMetric = Math.max(maxMetric, Math.abs(value));
      if (!flow && value > 0) samples.push(value);
    }
    previous = totals;
    metrics.set(column, metric);
  }
  const domain = model.heatAutoContrast
    ? autoContrastDomain(samples, model.heatLowPercentile, model.heatHighPercentile)
    : { low: 0, high: Math.max(maxMetric, 1) };
  const rowHeight = Math.max(1, Math.abs(scales.price.toPx(0) - scales.price.toPx(1)));
  for (let i = first; i < heat.length; i++) {
    const column = heat[i];
    if (!column || column.t > model.endMs) break;
    const x0 = scales.time.toPx(column.t);
    const x1 = scales.time.toPx(column.t + column.d);
    if (x1 < plot.x || x0 > plot.x + plot.w) continue;
    const metric = metrics.get(column);
    forEachHeatCell(column, (price) => {
      const value = metric?.get(price) ?? 0;
      const magnitude = Math.abs(value);
      if (magnitude <= 0 || price < model.lowTicks - 1 || price > model.highTicks + 1) return;
      const t = flow || !model.heatAutoContrast ? logIntensity(magnitude, maxMetric) : rampT(magnitude, domain.low, domain.high);
      const level = Math.min(HEAT_LEVELS - 1, Math.floor(t * model.heatContrast * HEAT_LEVELS));
      const y = scales.price.toPx(price + 0.5);
      const rect = [Math.max(plot.x, x0), y, Math.max(1, Math.min(plot.x + plot.w, x1) - Math.max(plot.x, x0)), rowHeight];
      (value < 0 ? pulled : added)[level]?.push(...rect);
    });
  }
  for (let level = 0; level < HEAT_LEVELS; level++) {
    const alpha = heatLevelAlpha(level, HEAT_LEVELS, model.heatDim);
    if (flow) {
      fillRects(ctx, added[level] ?? [], `rgba(${colors.addedRgb}, ${alpha.toFixed(3)})`);
      fillRects(ctx, pulled[level] ?? [], `rgba(${colors.pulledRgb}, ${alpha.toFixed(3)})`);
    } else {
      fillRects(ctx, added[level] ?? [], bookmapColor(level / (HEAT_LEVELS - 1), alpha));
    }
  }
  if (maxMetric <= 0) return null;
  // The cutoffs the ramp maps between, for the key: the percentile values with auto-contrast, zero and the largest
  // magnitude in view on the fixed scale and in flow. Contrast is shown beside them, never folded into them.
  return flow || !model.heatAutoContrast ? { low: 0, high: maxMetric } : { low: domain.low, high: domain.high };
}

/** Where the warmup band ends, so a zone is not filled under it (contrast.test.ts); none when no band is drawn. */
function warmupEdgeX(model: BookmapDrawModel, scales: ReturnType<typeof bookmapScales>): number {
  const mark = model.historyWatermarkMs;
  return mark === null || mark <= model.startMs || mark >= model.endMs ? Number.NEGATIVE_INFINITY : scales.time.toPx(mark);
}

function drawWarmup(
  ctx: CanvasRenderingContext2D,
  model: BookmapDrawModel,
  scales: ReturnType<typeof bookmapScales>,
): void {
  const mark = model.historyWatermarkMs;
  if (mark === null || mark <= model.startMs || mark >= model.endMs) return;
  const { plot } = model.frame;
  const x = scales.time.toPx(mark);
  ctx.fillStyle = withAlpha(palette.warmup, WARMUP_BAND_ALPHA);
  ctx.fillRect(plot.x, plot.y, Math.max(0, x - plot.x), plot.h);
  ctx.strokeStyle = palette.warmup;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, plot.y);
  ctx.lineTo(x, plot.y + plot.h);
  ctx.stroke();
  if (x - plot.x > 80) {
    ctx.fillStyle = palette.muted;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(WARMUP_NO_L2, plot.x + 8, plot.y + 8);
  }
}

/** Step of last price, clipped to the plot: above the heatmap, and this runs before the dots. */
function drawPriceLine(
  ctx: CanvasRenderingContext2D,
  model: BookmapDrawModel,
  scales: ReturnType<typeof bookmapScales>,
): void {
  const segments = priceSegments(model.priceSteps);
  if (segments.length === 0) return;
  const { plot } = model.frame;
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();
  for (const segment of segments) {
    const { warm, live } = splitWarmup(segment, model.historyWatermarkMs);
    tracePrice(ctx, scales, warm, palette.warmup, true);
    tracePrice(ctx, scales, live, palette.priceLine, false);
  }
  ctx.restore();
}

/** Warmup is dashed and gray. The live side is the solid light step. A point on the watermark is in both. */
function splitWarmup(
  segment: readonly { readonly timeMs: number; readonly priceTicks: number }[],
  watermarkMs: number | null,
): { readonly warm: { readonly timeMs: number; readonly priceTicks: number }[]; readonly live: { readonly timeMs: number; readonly priceTicks: number }[] } {
  if (watermarkMs === null) return { warm: [], live: [...segment] };
  const warm: { timeMs: number; priceTicks: number }[] = [];
  const live: { timeMs: number; priceTicks: number }[] = [];
  for (let index = 0; index < segment.length; index++) {
    const step = segment[index];
    if (!step) continue;
    if (step.timeMs <= watermarkMs) warm.push(step);
    if (step.timeMs >= watermarkMs) live.push(step);
    const previous = segment[index - 1];
    if (previous && previous.timeMs < watermarkMs && step.timeMs > watermarkMs) {
      // A step holds the previous price until the next trade. Interpolating would invent a price that never traded.
      const bridge = { timeMs: watermarkMs, priceTicks: previous.priceTicks };
      warm.push(bridge);
      live.unshift(bridge);
    }
  }
  return { warm, live };
}

function tracePrice(
  ctx: CanvasRenderingContext2D,
  scales: ReturnType<typeof bookmapScales>,
  steps: readonly { readonly timeMs: number; readonly priceTicks: number }[],
  color: string,
  dashed: boolean,
): void {
  const first = steps[0];
  if (!first || steps.length === 0) return;
  const stroke = (strokeColor: string, width: number) => {
    ctx.beginPath();
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = width;
    ctx.lineJoin = "miter";
    ctx.setLineDash(dashed ? [5, 4] : []);
    ctx.moveTo(scales.time.toPx(first.timeMs), scales.price.toPx(first.priceTicks));
    let price = first.priceTicks;
    for (let index = 1; index < steps.length; index++) {
      const step = steps[index];
      if (!step) continue;
      const x = scales.time.toPx(step.timeMs);
      ctx.lineTo(x, scales.price.toPx(price));
      ctx.lineTo(x, scales.price.toPx(step.priceTicks));
      price = step.priceTicks;
    }
    ctx.stroke();
  };
  stroke(dashed ? palette.priceLineHaloWarmup : palette.priceLineHalo, 3.25);
  stroke(color, 1.5);
  ctx.setLineDash([]);
}

function drawCandles(
  ctx: CanvasRenderingContext2D,
  model: BookmapDrawModel,
  scales: ReturnType<typeof bookmapScales>,
): void {
  for (const candle of model.candles) {
    if (candle.t + candle.d < model.startMs || candle.t > model.endMs) continue;
    const warmup = model.historyWatermarkMs !== null && candle.t <= model.historyWatermarkMs;
    const x0 = scales.time.toPx(candle.t);
    const x1 = scales.time.toPx(candle.t + candle.d);
    const body = Math.max(1, (x1 - x0) * 0.62);
    const cx = (x0 + x1) / 2;
    ctx.strokeStyle = warmup ? palette.warmup : candle.c >= candle.o ? palette.up : palette.down;
    ctx.lineWidth = 1;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(cx, scales.price.toPx(candle.h));
    ctx.lineTo(cx, scales.price.toPx(candle.l));
    ctx.stroke();
    const top = scales.price.toPx(Math.max(candle.o, candle.c));
    const bottom = scales.price.toPx(Math.min(candle.o, candle.c));
    ctx.fillRect(cx - body / 2, top, body, Math.max(1, bottom - top));
  }
}

function drawLevels(
  ctx: CanvasRenderingContext2D,
  model: BookmapDrawModel,
  scales: ReturnType<typeof bookmapScales>,
): void {
  const { plot } = model.frame;
  ctx.font = DATA_XS;
  for (const level of model.levels) {
    if (level.priceTicks < model.lowTicks || level.priceTicks > model.highTicks) continue;
    const y = Math.round(scales.price.toPx(level.priceTicks)) + 0.5;
    const shelf = level.emphasis === "hvn" || level.emphasis === "lvn";
    const hue = levelColor(level);
    if (shelf) {
      const band = Math.max(2, Math.abs(scales.price.toPx(0) - scales.price.toPx(1)));
      ctx.fillStyle = withAlpha(hue, model.emphasizeNodes ? 0.32 : 0.16);
      ctx.fillRect(plot.x, y - band / 2, plot.w, band);
    }
    ctx.strokeStyle = hue;
    ctx.lineWidth = 1;
    ctx.setLineDash(shelf ? [2, 3] : []);
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
    ctx.setLineDash([]);
    tagBox(ctx, level.name, plot.x + 8, y, hue);
  }
}

/** A named level's colour: the node shelves, the value area, POC and VWAP by name, any other level neutral. */
function levelColor(level: NamedGuide): string {
  switch (level.emphasis) {
    case "hvn":
      return palette.hvn;
    case "lvn":
      return palette.lvn;
    case "value":
      return palette.value;
    case "level":
      return level.name === "POC" ? palette.poc : level.name === "VWAP" ? palette.vwap : palette.neutral;
  }
}

/** An outlined tag on the stage, 15px high, centred on `y`: the level's name in its own colour. */
function tagBox(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, hue: string): void {
  const padding = 4;
  const height = 15;
  const width = ctx.measureText(text).width + padding * 2;
  const top = Math.round(y - height / 2) + 0.5;
  ctx.fillStyle = palette.stage;
  ctx.fillRect(x, top, width, height);
  ctx.strokeStyle = hue;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, top, width, height);
  ctx.fillStyle = hue;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + padding, y + 0.5);
}

function drawBbo(
  ctx: CanvasRenderingContext2D,
  model: BookmapDrawModel,
  scales: ReturnType<typeof bookmapScales>,
): void {
  const { plot } = model.frame;
  if (model.bboStale || model.bestBid === null || model.bestAsk === null) {
    ctx.fillStyle = palette.muted;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("BBO unknown", plot.x + 8, plot.y + 26);
    return;
  }
  // The quote is a side of the book: bid and ask, never up and down.
  for (const [ticks, color] of [
    [model.bestBid, palette.bid],
    [model.bestAsk, palette.ask],
  ] as const) {
    if (ticks < model.lowTicks || ticks > model.highTicks) continue;
    const y = Math.round(scales.price.toPx(ticks)) + 0.5;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
  }
}

function drawDots(
  ctx: CanvasRenderingContext2D,
  model: BookmapDrawModel,
  scales: ReturnType<typeof bookmapScales>,
): void {
  for (const dot of model.dots) {
    const x = scales.time.toPx(dot.timeMs);
    const y = scales.price.toPx(dot.priceTicks);
    ctx.beginPath();
    ctx.fillStyle = palette.sell;
    ctx.arc(x, y, dot.radius, 0, Math.PI * 2);
    ctx.fill();
    if (dot.buyFraction > 0) {
      ctx.beginPath();
      ctx.fillStyle = palette.buy;
      ctx.moveTo(x, y);
      ctx.arc(x, y, dot.radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * dot.buyFraction);
      ctx.closePath();
      ctx.fill();
    }
    strokeVolumeDotOutline(ctx, x, y, dot.radius, dot.buyFraction);
    if (dot.label) {
      // A five-glyph total is wider than the dot; the halo keeps the overflow readable on the stage.
      const text = formatQty(dot.total);
      // The halo's width and join stay with the label, not the next frame's strokes.
      ctx.save();
      ctx.font = DOT_LABEL;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      ctx.lineWidth = DOT_LABEL_HALO;
      ctx.strokeStyle = palette.dotLabelHalo;
      ctx.strokeText(text, x, y);
      ctx.fillStyle = palette.dotLabel;
      ctx.fillText(text, x, y);
      ctx.restore();
    }
  }
}

function drawMarker(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, inferred: boolean, radius: number): void {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(1.25, radius * (1.75 / 4.5));
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  if (inferred) ctx.stroke();
  else ctx.fill();
}

function drawSignals(
  ctx: CanvasRenderingContext2D,
  model: BookmapDrawModel,
  scales: ReturnType<typeof bookmapScales>,
): void {
  for (const signal of model.signals) {
    if (signal.timeMs < model.startMs || signal.timeMs > model.endMs) continue;
    const marker = eventMarker(signal.kind);
    ctx.globalAlpha = signal.thinTape === true ? THIN_TAPE_ALPHA : 1;
    drawMarker(ctx, scales.time.toPx(signal.timeMs), scales.price.toPx(signal.priceTicks), marker.color, signal.inferred, model.eventDotRadius);
  }
  ctx.globalAlpha = 1;
}

function drawReclaims(
  ctx: CanvasRenderingContext2D,
  model: BookmapDrawModel,
  scales: ReturnType<typeof bookmapScales>,
): void {
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  for (const mark of model.reclaims) {
    if (mark.timeMs < model.startMs || mark.timeMs > model.endMs) continue;
    const marker = eventMarker("FailedReclaim");
    drawMarker(ctx, scales.time.toPx(mark.timeMs), scales.price.toPx(mark.priceTicks), marker.color, true, model.eventDotRadius);
  }
}

function drawGuide(
  ctx: CanvasRenderingContext2D,
  model: BookmapDrawModel,
  scales: ReturnType<typeof bookmapScales>,
  guide: TrailGuide,
): void {
  const { plot } = model.frame;
  const y0 = scales.price.toPx(guide.fromTicks);
  const y1 = scales.price.toPx(guide.toTicks);
  ctx.strokeStyle = palette.guideText;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(plot.x + plot.w - 28, y0);
  ctx.lineTo(plot.x + plot.w - 8, y0);
  ctx.lineTo(plot.x + plot.w - 8, y1);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = DATA_SM;
  labelBox(ctx, guide.heading, plot.x + 8, Math.min(y0, y1) + 18, { fill: palette.guideFill, color: palette.guideText });
  labelBox(ctx, "Not an order", plot.x + 8, Math.min(y0, y1) + 36, { fill: palette.guideFill, color: palette.guideCaption });
}

function drawPriceColumn(
  ctx: CanvasRenderingContext2D,
  model: BookmapDrawModel,
  scales: ReturnType<typeof bookmapScales>,
): void {
  const { price } = model.frame;
  ctx.fillStyle = palette.dock;
  ctx.fillRect(price.x, price.y, price.w, price.h);
  ctx.fillStyle = palette.muted;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.font = DATA_XS;
  for (const tick of niceTicks(model.lowTicks, model.highTicks, Math.max(2, Math.floor(price.h / 48)))) {
    ctx.fillText(formatTicks(tick, model.spec), price.x + price.w - 6, scales.price.toPx(tick));
  }
  const last = model.lastPriceTicks;
  if (last !== null && last >= model.lowTicks && last <= model.highTicks) {
    const y = scales.price.toPx(last);
    labelBox(ctx, formatTicks(last, model.spec), price.x + price.w - 4, y, {
      fill: palette.priceTag,
      color: palette.onPriceTag,
      align: "right",
    });
  }
  const times = timeTicks(model.startMs, model.endMs, model.frame.plot.w);
  ctx.font = DATA_XS;
  ctx.fillStyle = palette.muted;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  for (const t of times) {
    ctx.fillText(formatLocalMinute(t), scales.time.toPx(t), model.frame.plot.y + model.frame.plot.h - 2);
  }
}

function drawCob(
  ctx: CanvasRenderingContext2D,
  model: BookmapDrawModel,
  scales: ReturnType<typeof bookmapScales>,
): void {
  const { cob } = model.frame;
  ctx.fillStyle = palette.dock;
  ctx.fillRect(cob.x, cob.y, cob.w, cob.h);
  if (model.cob.kind === "empty") {
    ctx.fillStyle = palette.muted;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = DATA_XS;
    wrapText(ctx, model.cob.label, cob.x + cob.w / 2, cob.y + cob.h / 2, cob.w - 8);
    return;
  }
  let max = 1;
  for (const level of model.cob.levels) max = Math.max(max, level.bid, level.ask);
  const mid = cob.x + cob.w / 2;
  const row = Math.max(1, Math.abs(scales.price.toPx(0) - scales.price.toPx(1)));
  for (const level of model.cob.levels) {
    if (level.priceTicks < model.lowTicks || level.priceTicks > model.highTicks) continue;
    const y = scales.price.toPx(level.priceTicks) - row / 2;
    ctx.fillStyle = palette.bid;
    ctx.fillRect(mid - (level.bid / max) * (cob.w / 2 - 4), y, (level.bid / max) * (cob.w / 2 - 4), row);
    ctx.fillStyle = palette.ask;
    ctx.fillRect(mid, y, (level.ask / max) * (cob.w / 2 - 4), row);
  }
}

function drawSvp(
  ctx: CanvasRenderingContext2D,
  model: BookmapDrawModel,
  scales: ReturnType<typeof bookmapScales>,
): void {
  const { svp } = model.frame;
  ctx.fillStyle = palette.dock;
  ctx.fillRect(svp.x, svp.y, svp.w, svp.h);
  let max = 1;
  for (const level of model.svp) max = Math.max(max, level.bid + level.ask + level.unsided);
  const row = Math.max(1, Math.abs(scales.price.toPx(0) - scales.price.toPx(1)));
  for (const level of model.svp) {
    if (level.priceTicks < model.lowTicks || level.priceTicks > model.highTicks) continue;
    const y = scales.price.toPx(level.priceTicks) - row / 2;
    const span = svp.w - 8;
    const bidW = (level.bid / max) * span;
    const askW = (level.ask / max) * span;
    const restW = (level.unsided / max) * span;
    // Volume traded at the bid was sold into, at the ask bought.
    ctx.fillStyle = palette.sell;
    ctx.fillRect(svp.x + 4, y, bidW, row);
    ctx.fillStyle = palette.buy;
    ctx.fillRect(svp.x + 4 + bidW, y, askW, row);
    ctx.fillStyle = palette.warmup;
    ctx.fillRect(svp.x + 4 + bidW + askW, y, restW, row);
  }
}

/** label-sm in capitals, muted: the column heads. */
function overline(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.font = LABEL_SM;
  ctx.fillStyle = palette.muted;
  ctx.letterSpacing = "0.44px";
  ctx.fillText(text, x, y);
  ctx.letterSpacing = "0px";
}

function drawHeaders(ctx: CanvasRenderingContext2D, frame: BookmapFrame): void {
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  overline(ctx, "PRICE", frame.price.x + frame.price.w / 2, frame.price.y + 4);
  overline(ctx, "COB (L2)", frame.cob.x + frame.cob.w / 2, frame.cob.y + 4);
  overline(ctx, "SVP (B/S)", frame.svp.x + frame.svp.w / 2, frame.svp.y + 4);
}

function drawHover(
  ctx: CanvasRenderingContext2D,
  input: { readonly frame: BookmapFrame; readonly spec: TickSpec; readonly hover: { readonly timeMs: number; readonly priceTicks: number } | null },
  scales: ReturnType<typeof bookmapScales>,
): void {
  const hover = input.hover;
  if (!hover) return;
  const { plot, price } = input.frame;
  const x = scales.time.toPx(hover.timeMs);
  const y = scales.price.toPx(hover.priceTicks);
  ctx.strokeStyle = palette.crosshair;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, plot.y);
  ctx.lineTo(x, plot.y + plot.h);
  ctx.moveTo(plot.x, y);
  ctx.lineTo(plot.x + plot.w, y);
  ctx.stroke();
  ctx.font = DATA_XS;
  labelBox(ctx, formatTicks(Math.round(hover.priceTicks), input.spec), price.x + price.w - 4, y, {
    fill: palette.strong,
    color: palette.card,
    align: "right",
  });
}

/** Paints only the hover crosshair, so a pointer move does not redraw the heatmap. */
export function drawBookmapHover(
  surface: Surface,
  input: {
    readonly frame: BookmapFrame;
    readonly startMs: number;
    readonly endMs: number;
    readonly lowTicks: number;
    readonly highTicks: number;
    readonly spec: TickSpec;
    readonly hover: { readonly timeMs: number; readonly priceTicks: number } | null;
  },
): void {
  if (!input.hover) return;
  const scales = bookmapScales(input.frame, input.startMs, input.endMs, input.lowTicks, input.highTicks);
  drawHover(surface.ctx, input, scales);
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number): void {
  const words = text.split(" ");
  let line = "";
  let dy = -8;
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      ctx.fillText(line, x, y + dy);
      line = word;
      dy += 12;
    } else {
      line = next;
    }
  }
  if (line) ctx.fillText(line, x, y + dy);
}

function fillRects(ctx: CanvasRenderingContext2D, rects: readonly number[], color: string): void {
  ctx.fillStyle = color;
  for (let i = 0; i + 3 < rects.length; i += 4) {
    ctx.fillRect(rects[i] ?? 0, rects[i + 1] ?? 0, rects[i + 2] ?? 0, rects[i + 3] ?? 0);
  }
}

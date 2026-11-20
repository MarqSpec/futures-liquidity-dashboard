import type { Footprint, HeatColumn, LevelTouch, Profile, RangeZone, Signal } from "../api/schemas.ts";
import { withAlpha } from "../design/color.ts";
import type { Candle } from "../domain/candles.ts";
import { formatAge, formatChicagoTime, formatLocalMinute, formatLocalTime, formatPercent, formatQty, formatTickRange, formatTicks } from "../domain/format.ts";
import { firstColumnEndingAfter, forEachHeatCell, logIntensity } from "../domain/heat.ts";
import { autoContrastDomain, bookmapColor, rampT } from "../domain/heatRamp.ts";
import type { HeatMode } from "../domain/layout.ts";
import { HISTORY_WITHOUT_TAPE, TAPE_STARTS_HERE, aggressorColor, candleIsPriceMark, tapeBoundaryMs, tradeFlashAlpha, volumeDots } from "../domain/volumeDots.ts";
import type { MarketState } from "../domain/merge.ts";
import { touchOutcomeText } from "../domain/quote.ts";
import { linearScale, niceTicks, timeTicks, type LinearScale } from "../domain/scale.ts";
import { biasColors, kindName } from "../domain/signals.ts";
import { THIN_TAPE_ALPHA, THIN_TAPE_LINE } from "../domain/tape.ts";
import { hatchPattern, labelBox, type Surface } from "../lib/canvas.ts";
import { AXIS_WIDTH, canvasColors, colors, emaColors, fonts, MONO, PROFILE_GUTTER, themed } from "../theme.ts";
import { emaPath } from "../domain/lineTags.ts";
import { drawLineTags } from "./drawLineTags.ts";
import { drawRangeZones } from "./drawRangeZones.ts";
import { strokeVolumeDotOutline } from "./volumeDotOutline.ts";

/** Height of the time axis under the main chart. */
export const TIME_AXIS_HEIGHT = 20;

/** What the main chart draws. */
export interface MainChartModel {
  readonly market: MarketState;
  readonly candles: readonly Candle[];
  readonly startMs: number;
  readonly endMs: number;
  readonly lowTicks: number;
  readonly highTicks: number;
  readonly heatmap: boolean;
  readonly heatColumns: readonly HeatColumn[];
  readonly heatMode: HeatMode;
  readonly heatContrast: number;
  readonly heatScale: number;
  /** Optional candles. Volume dots stay the primary mark when this is off (REQUIREMENTS.md FR-59). */
  readonly showCandles?: boolean;
  /** Defaults on. */
  readonly showVolumeDots?: boolean;
  readonly heatDim?: number;
  readonly heatLowPercentile?: number;
  readonly heatHighPercentile?: number;
  /** Draw-time stretch. Stored heat cells are not rewritten (REQUIREMENTS.md FR-58). */
  readonly heatAutoContrast?: boolean;
  readonly dotMinQuantity?: number;
  readonly hideValueArea?: boolean;
  readonly emphasizeNodes?: boolean;
  readonly levelTouches: readonly LevelTouch[];
  readonly profile: Profile | null;
  readonly emaIds: readonly string[];
  readonly vwap: boolean;
  readonly overlay: boolean;
  /** Names the VWAP, its bands and each EMA on the price axis. Default on (REQUIREMENTS.md FR-77). */
  readonly lineTags?: boolean;
  readonly signals: readonly Signal[];
  readonly isKindOn: (kind: string) => boolean;
  /** Set when Detail's main chart is the footprint (REQUIREMENTS.md FR-22): drawn instead of the price chart, on the same window. */
  readonly footprint?: FootprintLayer | null;
  /** Range zones to shade behind the price marks (REQUIREMENTS.md FR-75). They never change the price fit. */
  readonly rangeZones?: readonly RangeZone[];
}

/** The footprint bars Detail's main chart draws when it shows the footprint. */
export interface FootprintLayer {
  readonly bars: readonly Footprint[];
  readonly developing: Footprint | null;
  readonly missingRanges: readonly (readonly (number | null | undefined)[])[];
  readonly approximateRanges: readonly (readonly (number | null | undefined)[])[];
}

/** Something under the pointer that has a tooltip. */
export interface Marker {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly title: string;
  readonly lines: readonly string[];
}

/** The scales the chart was drawn with, and its hover targets. */
export interface MainChartGeometry {
  readonly plotWidth: number;
  readonly plotHeight: number;
  readonly plotLeft: number;
  readonly time: LinearScale;
  readonly price: LinearScale;
  readonly markers: readonly Marker[];
  /** Where the time axis starts, when a row sits between it and the plot (the footprint's delta row). */
  readonly timeAxisTop?: number;
}

const HEAT_LEVELS = 16;

// Alpha variants of the tokens, built once per theme.
const tints = themed((theme) => {
  const c = canvasColors(theme);
  return {
    vwapBandFill: withAlpha(c.vwap, 0.07),
    vwapLabelFill: withAlpha(c.vwap, 0.25),
    vwapSigmaFill: withAlpha(c.vwap, 0.18),
    thirdTouch: withAlpha(c.lastPrice, 0.95),
    // Levels and the quote are not price directions: they never take up or down.
    highLevel: withAlpha(c.resistance, 0.55),
    lowLevel: withAlpha(c.support, 0.55),
    shelfBin: withAlpha(c.nodeHvn, 0.95),
    slideBin: withAlpha(c.nodeLvn, 0.85),
    pocBin: withAlpha(c.poc, 0.9),
    valueBin: withAlpha(c.value, 0.75),
    otherBin: withAlpha(c.single, 0.45),
    valueAreaFill: withAlpha(c.value, 0.08),
    statusWatermark: withAlpha(c.warning, 0.07),
  };
});

function fillRects(ctx: CanvasRenderingContext2D, rects: readonly number[], style: string | CanvasPattern): void {
  if (rects.length === 0) {
    return;
  }
  ctx.fillStyle = style;
  ctx.beginPath();
  for (let i = 0; i + 3 < rects.length; i += 4) {
    ctx.rect(rects[i] ?? 0, rects[i + 1] ?? 0, rects[i + 2] ?? 0, rects[i + 3] ?? 0);
  }
  ctx.fill();
}

function columnTotals(column: HeatColumn): Map<number, number> {
  const totals = new Map<number, number>();
  forEachHeatCell(column, (price, bid, ask) => totals.set(price, bid + ask));
  return totals;
}

function drawHeatmap(ctx: CanvasRenderingContext2D, m: MainChartModel, time: LinearScale, price: LinearScale, w: number, h: number) {
  ctx.fillStyle = colors.heatGround;
  ctx.fillRect(0, 0, w, h);
  const heat = m.heatColumns;
  const samples: number[] = [];
  const added: number[][] = Array.from({ length: HEAT_LEVELS }, () => []);
  const pulled: number[][] = Array.from({ length: HEAT_LEVELS }, () => []);
  const resting: number[][] = Array.from({ length: HEAT_LEVELS }, () => []);
  const unknown: number[][] = [[], [], []];
  const uncovered: number[] = [];
  const rowHeight = Math.max(1, Math.abs(price.toPx(0) - price.toPx(1)));
  let lastX = Number.NEGATIVE_INFINITY;
  let expectedT: number | null = null;
  const hatch = hatchPattern(ctx);
  const flow = m.heatMode === "flow";
  const auto = m.heatAutoContrast !== false;
  const dim = Math.min(1, Math.max(0, m.heatDim ?? 0));
  const first = firstColumnEndingAfter(heat, m.startMs);
  let previous = first > 0 && heat[first - 1] ? columnTotals(heat[first - 1]!) : new Map<number, number>();
  let maxMetric = 0;
  const metrics = new Map<HeatColumn, Map<number, number>>();
  for (let i = first; i < heat.length; i++) {
    const column = heat[i];
    if (!column || column.t > m.endMs) break;
    const totals = columnTotals(column);
    const metric = new Map<number, number>();
    if (flow) {
      for (const [levelPrice, total] of totals) {
        const delta = previous.has(levelPrice) ? total - (previous.get(levelPrice) ?? 0) : 0;
        metric.set(levelPrice, delta);
        maxMetric = Math.max(maxMetric, Math.abs(delta));
      }
    } else {
      for (const [levelPrice, total] of totals) {
        metric.set(levelPrice, total);
        maxMetric = Math.max(maxMetric, total);
        if (total > 0) samples.push(total);
      }
    }
    previous = totals;
    metrics.set(column, metric);
  }
  const domain = auto
    ? autoContrastDomain(samples, m.heatLowPercentile ?? 5, m.heatHighPercentile ?? 95)
    : { low: 0, high: Math.max(maxMetric, 1) };

  // Time with no slice at all is unknown depth, never empty depth.
  const gaps: [number, number][] = [];
  for (let i = first; i < heat.length; i++) {
    const column = heat[i];
    if (!column) continue;
    if (column.t > m.endMs) break;
    if (expectedT !== null && column.t - expectedT > column.d * 1.5) {
      gaps.push([expectedT, column.t]);
    }
    expectedT = column.t + column.d;
    const x0 = time.toPx(column.t);
    const x1 = time.toPx(column.t + column.d);
    if (x1 < 0 || x0 > w) continue;
    // Several slices in one pixel: draw the first, skip the rest.
    if (x1 <= lastX) continue;
    const left = Math.max(x0, lastX);
    const width = Math.max(1, x1 - left);
    lastX = left + width;
    const duration = column.d > 0 ? column.d : 1;
    const metric = metrics.get(column);
    let minP = Number.POSITIVE_INFINITY;
    let maxP = Number.NEGATIVE_INFINITY;
    forEachHeatCell(column, (p, _b, _a, knownMs) => {
      minP = Math.min(minP, p);
      maxP = Math.max(maxP, p);
      if (p < m.lowTicks - 1 || p > m.highTicks + 1) return;
      const y = price.toPx(p + 0.5);
      const unknownFraction = 1 - knownMs / duration;
      if (unknownFraction > 0.02) {
        unknown[unknownFraction > 0.66 ? 2 : unknownFraction > 0.33 ? 1 : 0]?.push(left, y, width, rowHeight);
      }
      const value = metric?.get(p) ?? 0;
      const magnitude = Math.abs(value);
      if (magnitude <= 0 || maxMetric <= 0) return;
      const t = !flow && auto ? rampT(magnitude, domain.low, domain.high) : logIntensity(magnitude, maxMetric);
      const level = Math.min(HEAT_LEVELS - 1, Math.floor(t * m.heatContrast * HEAT_LEVELS));
      const bucket = flow ? (value > 0 ? added : pulled) : resting;
      bucket[level]?.push(left, y, width, rowHeight);
    });
    if (minP <= maxP) {
      const top = price.toPx(maxP + 0.5);
      const bottom = price.toPx(minP - 0.5);
      if (top > 0) uncovered.push(left, 0, width, top);
      if (bottom < h) uncovered.push(left, bottom, width, h - bottom);
    }
  }
  const firstColumn = heat[first];
  const lead = firstColumn ? Math.min(firstColumn.t, m.endMs) : Math.min(m.endMs, m.market.serverTimeMs);
  if (lead > m.startMs) {
    gaps.unshift([m.startMs, lead]);
  }

  for (let level = 0; level < HEAT_LEVELS; level++) {
    const alpha = (0.15 + (0.85 * (level + 1)) / HEAT_LEVELS) * (1 - dim * 0.85);
    if (flow) {
      fillRects(ctx, added[level] ?? [], `rgba(${colors.addedRgb}, ${alpha.toFixed(3)})`);
      fillRects(ctx, pulled[level] ?? [], `rgba(${colors.pulledRgb}, ${alpha.toFixed(3)})`);
    } else {
      fillRects(ctx, resting[level] ?? [], bookmapColor(level / (HEAT_LEVELS - 1), alpha));
    }
  }
  ctx.save();
  [0.25, 0.5, 0.8].forEach((alpha, i) => {
    ctx.globalAlpha = alpha;
    fillRects(ctx, unknown[i] ?? [], hatch);
  });
  ctx.globalAlpha = 0.12;
  fillRects(ctx, uncovered, hatch);
  ctx.globalAlpha = 0.35;
  for (const [from, to] of gaps) {
    const x0 = Math.max(0, time.toPx(from));
    const x1 = Math.min(w, time.toPx(to));
    if (x1 > x0) {
      fillRects(ctx, [x0, 0, x1 - x0, h], hatch);
    }
  }
  ctx.restore();
  for (const [from, to] of gaps) {
    const x0 = Math.max(0, time.toPx(from));
    const x1 = Math.min(w, time.toPx(to));
    if (x1 - x0 > 90) {
      ctx.fillStyle = colors.muted;
      ctx.font = fonts.sm;
      ctx.textAlign = "center";
      ctx.fillText("depth unknown", (x0 + x1) / 2, 14);
    }
  }
}

function drawGrid(ctx: CanvasRenderingContext2D, m: MainChartModel, time: LinearScale, price: LinearScale, w: number, h: number) {
  const spec = m.market.instrument;
  const left = m.profile ? PROFILE_GUTTER : 0;
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const prices = niceTicks(m.lowTicks, m.highTicks, Math.max(2, Math.floor(h / 48)));
  for (const p of prices) {
    const y = Math.round(price.toPx(p)) + 0.5;
    ctx.moveTo(left, y);
    ctx.lineTo(w, y);
  }
  const times = timeTicks(m.startMs, m.endMs, w);
  for (const t of times) {
    const x = Math.round(time.toPx(t)) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  ctx.stroke();

  ctx.font = fonts.sm;
  ctx.fillStyle = colors.axis;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  for (const p of prices) {
    ctx.fillText(formatTicks(p, spec), w + 6, price.toPx(p));
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const t of times) {
    ctx.fillText(formatLocalMinute(t), time.toPx(t), h + 5);
  }
}

function drawCandles(ctx: CanvasRenderingContext2D, m: MainChartModel, time: LinearScale, price: LinearScale, tapeStartMs: number | null) {
  for (const candle of m.candles) {
    if (candle.t + candle.d < m.startMs || candle.t > m.endMs) continue;
    if (!candleIsPriceMark(candle.t, m.showCandles === true, tapeStartMs)) continue;
    const x0 = time.toPx(candle.t);
    const x1 = time.toPx(candle.t + candle.d);
    const slot = x1 - x0;
    const body = Math.max(1, slot * 0.68);
    const cx = x0 + slot / 2;
    const color = candle.c >= candle.o ? colors.up : colors.down;
    ctx.globalAlpha = candle.developing ? 0.75 : 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(cx) + 0.5, price.toPx(candle.h + 0.5));
    ctx.lineTo(Math.round(cx) + 0.5, price.toPx(candle.l - 0.5));
    ctx.stroke();
    const top = price.toPx(Math.max(candle.o, candle.c) + 0.5);
    const bottom = price.toPx(Math.min(candle.o, candle.c) - 0.5);
    ctx.fillStyle = color;
    ctx.fillRect(cx - body / 2, top, body, Math.max(1, bottom - top));
    if (candle.developing) {
      ctx.strokeStyle = colors.text;
      ctx.strokeRect(cx - body / 2 + 0.5, top + 0.5, body - 1, Math.max(1, bottom - top) - 1);
    }
  }
  ctx.globalAlpha = 1;
}

function drawVolumeDots(ctx: CanvasRenderingContext2D, m: MainChartModel, time: LinearScale, price: LinearScale) {
  const dots = volumeDots({
    prints: m.market.prints,
    historyWatermarkMs: m.market.historyWatermarkMs,
    startMs: m.startMs,
    endMs: m.endMs,
    plotWidthPx: Math.max(1, Math.abs(time.r1 - time.r0)),
    priceSpanTicks: Math.max(1, m.highTicks - m.lowTicks),
    plotHeightPx: Math.max(1, Math.abs(price.r1 - price.r0)),
    minQuantity: m.dotMinQuantity ?? 1,
  });
  for (const dot of dots) {
    const x = time.toPx(dot.timeMs);
    const y = price.toPx(dot.priceTicks);
    ctx.beginPath();
    ctx.fillStyle = aggressorColor(dot.aggressor);
    ctx.globalAlpha = 0.9;
    ctx.arc(x, y, dot.radius, 0, Math.PI * 2);
    ctx.fill();
    // The same outline as Order Flow's, so a green or red edge means the same aggressor on every tab.
    strokeVolumeDotOutline(ctx, x, y, dot.radius, dot.aggressor === "Bid" ? 1 : 0);
  }
  ctx.globalAlpha = 1;
}

function drawNodes(ctx: CanvasRenderingContext2D, m: MainChartModel, price: LinearScale, w: number) {
  const profile = m.profile;
  if (!profile) return;
  ctx.font = fonts.xs;
  ctx.setLineDash([2, 3]);
  ctx.lineWidth = 1.4;
  for (const [ticks, label, color] of [
    ...profile.hvn.map((ticks) => [ticks, "HVN shelf", colors.nodeHvn] as const),
    ...profile.lvn.map((ticks) => [ticks, "LVN slidy zone", colors.nodeLvn] as const),
  ]) {
    if (ticks < m.lowTicks || ticks > m.highTicks) continue;
    const y = Math.round(price.toPx(ticks)) + 0.5;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(label, 48, y - 1);
  }
  ctx.setLineDash([]);
}

function drawBbo(ctx: CanvasRenderingContext2D, m: MainChartModel, price: LinearScale, w: number) {
  const book = m.market.liquidity;
  const stale = book.quoteStale || m.market.status.code === "STALE" || book.bestBid == null || book.bestAsk == null;
  if (stale) {
    ctx.font = fonts.xs;
    ctx.fillStyle = colors.muted;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("BBO unknown", 8, 28);
    return;
  }
  ctx.lineWidth = 1;
  // The quote is a side of the book: bid and ask, never up and down.
  for (const [ticks, color] of [
    [book.bestBid, colors.bid],
    [book.bestAsk, colors.ask],
  ] as const) {
    if (ticks == null || ticks < m.lowTicks || ticks > m.highTicks) continue;
    const y = Math.round(price.toPx(ticks)) + 0.5;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
}

function drawLastTrade(ctx: CanvasRenderingContext2D, m: MainChartModel, time: LinearScale, price: LinearScale, w: number) {
  const last = m.market.prints.at(-1);
  if (!last) return;
  if (m.market.historyWatermarkMs !== null && last.sourceTimeMs <= m.market.historyWatermarkMs) return;
  if (last.aggressor !== "Bid" && last.aggressor !== "Ask") return;
  const arrived = m.market.printArrivedAtMs;
  if (arrived == null) return;
  const alpha = tradeFlashAlpha(m.market.receivedAtMs, arrived);
  if (alpha <= 0) return;
  const y = price.toPx(last.priceTicks);
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = aggressorColor(last.aggressor);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(time.toPx(last.sourceTimeMs), y);
  ctx.lineTo(Math.min(w, time.toPx(last.sourceTimeMs) + 18), y);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawEmas(ctx: CanvasRenderingContext2D, m: MainChartModel, time: LinearScale, price: LinearScale) {
  for (const id of m.emaIds) {
    const series = m.market.indicators.find((i) => i.id === id);
    if (!series) continue;
    ctx.strokeStyle = emaColors[id] ?? colors.text;
    ctx.lineWidth = id === "ema200" ? 1.6 : 1.2;
    ctx.globalAlpha = series.ready ? 1 : 0.45;
    ctx.setLineDash(series.ready ? [] : [3, 3]);
    ctx.beginPath();
    emaPath(series, { startMs: m.startMs, endMs: m.endMs, serverTimeMs: m.market.serverTimeMs }).forEach(([t, v], i) => {
      if (i === 0) ctx.moveTo(time.toPx(t), price.toPx(v));
      else ctx.lineTo(time.toPx(t), price.toPx(v));
    });
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

function drawVwap(ctx: CanvasRenderingContext2D, m: MainChartModel, time: LinearScale, price: LinearScale, w: number) {
  const trail = m.market.vwapTrail.filter((p) => p[0] >= m.startMs);
  if (trail.length > 1) {
    ctx.fillStyle = tints.vwapBandFill;
    ctx.beginPath();
    trail.forEach((p, i) => (i === 0 ? ctx.moveTo(time.toPx(p[0]), price.toPx(p[1] + p[2])) : ctx.lineTo(time.toPx(p[0]), price.toPx(p[1] + p[2]))));
    for (let i = trail.length - 1; i >= 0; i--) {
      const p = trail[i];
      if (p) ctx.lineTo(time.toPx(p[0]), price.toPx(p[1] - p[2]));
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = colors.vwap;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    trail.forEach((p, i) => (i === 0 ? ctx.moveTo(time.toPx(p[0]), price.toPx(p[1])) : ctx.lineTo(time.toPx(p[0]), price.toPx(p[1]))));
    ctx.stroke();
  }
  const { vwap, stdDev } = m.market.vwap;
  if (vwap === null || vwap === undefined || !Number.isFinite(vwap)) return;
  const y = price.toPx(vwap);
  ctx.strokeStyle = colors.vwap;
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(w, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.font = fonts.xs;
  labelBox(ctx, `VWAP${m.market.vwap.partial ? " (partial)" : ""}`, 4, y, { fill: tints.vwapLabelFill, color: colors.text });
  if (stdDev !== null && stdDev !== undefined && Number.isFinite(stdDev) && stdDev > 0) {
    for (const band of [1, 2]) {
      ctx.globalAlpha = band === 1 ? 0.7 : 0.4;
      ctx.strokeStyle = colors.vwap;
      ctx.setLineDash(band === 1 ? [2, 3] : [1, 4]);
      ctx.beginPath();
      for (const sign of [1, -1]) {
        const ys = price.toPx(vwap + sign * band * stdDev);
        ctx.moveTo(0, ys);
        ctx.lineTo(w, ys);
      }
      ctx.stroke();
      labelBox(ctx, `${band === 1 ? "+" : ""}±${band}σ`, w - 36, price.toPx(vwap + band * stdDev), {
        fill: tints.vwapSigmaFill,
        color: colors.muted,
      });
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }
}

function drawKeyLevels(ctx: CanvasRenderingContext2D, m: MainChartModel, price: LinearScale, w: number, markers: Marker[]) {
  const spec = m.market.instrument;
  ctx.font = fonts.xs;
  const levels =
    m.levelTouches.length > 0
      ? m.levelTouches
      : m.market.orderFlow.keyLevels.map((level) => ({
          name: level.name,
          priceTicks: level.priceTicks,
          isHigh: level.isHigh,
          touches: 0,
          isThirdTouch: false,
          held: 0,
          broke: 0,
        }));
  for (const level of levels) {
    if (level.priceTicks < m.lowTicks || level.priceTicks > m.highTicks) continue;
    if (level.name === "VWAP" && m.vwap) continue;
    const y = Math.round(price.toPx(level.priceTicks)) + 0.5;
    const third = level.isThirdTouch;
    ctx.strokeStyle = third ? tints.thirdTouch : level.isHigh ? tints.highLevel : tints.lowLevel;
    ctx.setLineDash(third ? [] : [1, 3]);
    ctx.lineWidth = third ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.setLineDash([]);
    const label = level.touches > 0 ? `${level.name} · ${third ? "3rd" : level.touches}` : level.name;
    ctx.fillStyle = third ? colors.lastPrice : colors.muted;
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText(label, w - 46, y - 1);
    markers.push({
      x: w - 46 - ctx.measureText(label).width / 2,
      y: y - 6,
      r: 8,
      title: third ? `Third touch · ${level.name}` : `Key level · ${level.name}`,
      lines: [formatTicks(level.priceTicks, spec), touchOutcomeText(level)],
    });
  }
}

function drawProfileGutter(ctx: CanvasRenderingContext2D, m: MainChartModel, price: LinearScale, gutter: number, h: number) {
  const profile = m.profile;
  if (!profile || gutter <= 0) return;
  ctx.fillStyle = colors.panel;
  ctx.fillRect(0, 0, gutter - 4, h);
  let max = 1;
  for (const bin of profile.bins) {
    const priceTicks = bin[0];
    if (priceTicks < m.lowTicks || priceTicks > m.highTicks) continue;
    max = Math.max(max, bin[1]);
  }
  const rowHeight = Math.max(1, Math.abs(price.toPx(0) - price.toPx(1)));
  for (const bin of profile.bins) {
    const priceTicks = bin[0];
    if (priceTicks < m.lowTicks || priceTicks > m.highTicks) continue;
    const width = Math.max(1, ((bin[1] / max) * (gutter - 10)));
    const y = price.toPx(priceTicks + 0.5);
    const inValue =
      profile.val != null && profile.vah != null && priceTicks >= profile.val && priceTicks <= profile.vah;
    const node = m.emphasizeNodes && (profile.hvn.includes(priceTicks) || profile.lvn.includes(priceTicks));
    const shelf = m.emphasizeNodes && profile.hvn.includes(priceTicks);
    const slide = m.emphasizeNodes && profile.lvn.includes(priceTicks);
    ctx.fillStyle = shelf ? tints.shelfBin : slide ? tints.slideBin : priceTicks === profile.poc ? tints.pocBin : inValue ? tints.valueBin : tints.otherBin;
    if (node) {
      ctx.globalAlpha = 1;
    }
    ctx.fillRect(gutter - 6 - width, y, width, rowHeight);
    ctx.globalAlpha = 1;
  }
  ctx.font = fonts.xs;
  ctx.fillStyle = colors.muted;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(profile.window, 2, 2);
}

function drawValueArea(ctx: CanvasRenderingContext2D, profile: Profile, price: LinearScale, w: number, hideValueArea: boolean) {
  if (profile.poc == null) return;
  ctx.save();
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 1;
  if (!hideValueArea && profile.vah != null && profile.val != null) {
    const yHigh = price.toPx(profile.vah);
    const yLow = price.toPx(profile.val);
    ctx.fillStyle = tints.valueAreaFill;
    ctx.fillRect(0, Math.min(yHigh, yLow), w, Math.abs(yLow - yHigh));
  }
  const lines: readonly (readonly [number, string, string])[] = hideValueArea
    ? [[profile.poc, "POC", colors.poc]]
    : [
        [profile.poc, "POC", colors.poc],
        ...(profile.vah == null ? [] : [[profile.vah, "VAH", colors.value] as const]),
        ...(profile.val == null ? [] : [[profile.val, "VAL", colors.value] as const]),
      ];
  for (const [ticks, label, color] of lines) {
    const y = Math.round(price.toPx(ticks)) + 0.5;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = fonts.xs;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(label, 4, y - 1);
  }
  ctx.restore();
}

function drawOverlay(ctx: CanvasRenderingContext2D, m: MainChartModel, price: LinearScale, w: number, markers: Marker[]) {
  const overlay = m.market.overlay;
  if (!overlay) return;
  const spec = m.market.instrument;
  ctx.font = fonts.xs;
  for (const level of overlay.levels) {
    if (level.priceTicks < m.lowTicks || level.priceTicks > m.highTicks) continue;
    const color = level.kind === "support" ? colors.support : level.kind === "resistance" ? colors.resistance : colors.reference;
    const y = Math.round(price.toPx(level.priceTicks)) + 0.5;
    ctx.globalAlpha = overlay.expired ? 0.35 : 0.95;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([8, 5]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.setLineDash([]);
    const text = `${level.label} ${formatTicks(level.priceTicks, spec)}${overlay.expired ? " (expired)" : ""}`;
    const width = labelBox(ctx, text, 70, y, { fill: colors.scrim, color });
    markers.push({
      x: 70 + width / 2,
      y,
      r: Math.max(8, width / 2),
      title: `Agent overlay · ${level.label}`,
      lines: [`${level.kind} at ${formatTicks(level.priceTicks, spec)}`, `by ${overlay.publisher}`, overlay.expired ? "expired" : "current"],
    });
  }
  ctx.globalAlpha = 1;
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
}

function triangle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, up: boolean) {
  ctx.beginPath();
  if (up) {
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y + r);
    ctx.lineTo(x - r, y + r);
  } else {
    ctx.moveTo(x, y + r);
    ctx.lineTo(x + r, y - r);
    ctx.lineTo(x - r, y - r);
  }
  ctx.closePath();
}

function letterMarker(ctx: CanvasRenderingContext2D, x: number, y: number, letter: string, color: string) {
  ctx.fillStyle = colors.scrim;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = fonts.mark;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(letter, x, y + 0.5);
}

/**
 * A signal marker whose tooltip text is built on first read. Every visible signal is a marker on every draw, but only
 * the hovered one is ever read, so the strings are not built for the rest.
 */
function signalText(signal: Signal, spec: MarketState["instrument"]): { readonly title: string; readonly lines: readonly string[] } {
  let lines: readonly string[] | undefined;
  return {
    get title() {
      return `${kindName(signal.kind)} · ${signal.label}`;
    },
    get lines() {
      lines ??= [
        `${formatLocalTime(signal.timeMs)} · ${formatChicagoTime(signal.timeMs)}`,
        formatTickRange(signal.priceTicks, signal.priceHighTicks, spec),
        signal.detail,
        `strength ${formatPercent(signal.strength)}`,
        ...(signal.thinTape === true ? [THIN_TAPE_LINE] : []),
      ];
      return lines;
    },
  };
}

function signalMarker(x: number, y: number, r: number, text: ReturnType<typeof signalText>): Marker {
  return {
    x,
    y,
    r,
    get title() {
      return text.title;
    },
    get lines() {
      return text.lines;
    },
  };
}

function drawSignals(ctx: CanvasRenderingContext2D, m: MainChartModel, time: LinearScale, price: LinearScale, w: number, markers: Marker[]) {
  const spec = m.market.instrument;
  const barMs = m.market.orderFlow.footprintSeconds * 1000;
  for (const signal of m.signals) {
    if (signal.timeMs < m.startMs - barMs || signal.timeMs > m.endMs) continue;
    const color = biasColors[signal.bias];
    const x = time.toPx(signal.timeMs);
    const yLow = price.toPx(signal.priceTicks);
    const yHigh = price.toPx(signal.priceHighTicks);
    const y = (yLow + yHigh) / 2;
    if (y < -20 || y > price.r0 + 20) continue;
    const alpha = signal.thinTape === true ? THIN_TAPE_ALPHA : 1;
    const text = signalText(signal, spec);
    ctx.globalAlpha = alpha;
    switch (signal.kind) {
      case "Iceberg": {
        const r = 3 + 5 * signal.strength;
        ctx.fillStyle = color;
        ctx.strokeStyle = colors.strong;
        ctx.lineWidth = 1;
        diamond(ctx, x, y, r);
        ctx.fill();
        ctx.stroke();
        markers.push(signalMarker(x, y, r + 3, text));
        break;
      }
      case "Spoof": {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        markers.push(signalMarker(x, y, 9, text));
        break;
      }
      case "LiquiditySweep": {
        const up = signal.bias !== "Bearish";
        const tip = up ? yLow + 4 : yHigh - 4;
        const tail = up ? tip + 18 : tip - 18;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, tail);
        ctx.lineTo(x, tip);
        ctx.stroke();
        triangle(ctx, x, tip + (up ? 2 : -2), 5, up);
        ctx.fill();
        markers.push(signalMarker(x, (tip + tail) / 2, 11, text));
        break;
      }
      case "StackedImbalance": {
        const x1 = time.toPx(signal.timeMs + barMs);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.18 * alpha;
        ctx.fillRect(x, price.toPx(signal.priceHighTicks + 0.5), Math.max(2, x1 - x), Math.max(2, yLow - yHigh + Math.abs(price.toPx(0) - price.toPx(1))));
        ctx.globalAlpha = alpha;
        markers.push(signalMarker((x + x1) / 2, y, Math.max(6, (x1 - x) / 2), text));
        break;
      }
      case "UnfinishedAuction": {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 10, y);
        ctx.stroke();
        markers.push(signalMarker(x + 5, y, 7, text));
        break;
      }
      case "TrappedTraders": {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        triangle(ctx, x, y, 6, signal.bias === "Bullish");
        ctx.stroke();
        markers.push(signalMarker(x, y, 9, text));
        break;
      }
      case "DeltaExhaustion":
        letterMarker(ctx, x, y, "E", color);
        markers.push(signalMarker(x, y, 9, text));
        break;
      case "CvdDivergence":
        letterMarker(ctx, x, y, "D", color);
        markers.push(signalMarker(x, y, 9, text));
        break;
      case "SinglePrints": {
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.1 * alpha;
        ctx.fillRect(x, yHigh, Math.max(0, w - x), Math.max(2, yLow - yHigh));
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x + 4, yHigh);
        ctx.lineTo(x, yHigh);
        ctx.lineTo(x, yLow);
        ctx.lineTo(x + 4, yLow);
        ctx.stroke();
        markers.push(signalMarker(x, y, Math.max(8, (yLow - yHigh) / 2), text));
        break;
      }
      default:
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
        markers.push(signalMarker(x, y, 7, text));
    }
  }
  ctx.globalAlpha = 1;
}

function drawOrderFlowState(ctx: CanvasRenderingContext2D, m: MainChartModel, time: LinearScale, price: LinearScale, w: number, markers: Marker[]) {
  const spec = m.market.instrument;
  const flow = m.market.orderFlow;
  const barMs = flow.footprintSeconds * 1000;
  const rowHeight = Math.max(2, Math.abs(price.toPx(0) - price.toPx(1)));
  if (m.isKindOn("StackedImbalance")) {
    for (const zone of flow.zones) {
      const top = price.toPx(zone.highTicks + 0.5);
      const bottom = price.toPx(zone.lowTicks - 0.5);
      ctx.fillStyle = biasColors[zone.bias];
      ctx.globalAlpha = 0.4;
      ctx.fillRect(w - 36, top, 36, Math.max(2, bottom - top));
      ctx.globalAlpha = 1;
      markers.push({
        x: w - 18,
        y: (top + bottom) / 2,
        r: Math.max(8, (bottom - top) / 2),
        title: `Imbalance zone · ${zone.bias}`,
        lines: [formatTickRange(zone.lowTicks, zone.highTicks, spec), `${zone.levels} levels at ${zone.averageRatio.toFixed(1)}× average`],
      });
    }
  }
  if (m.isKindOn("UnfinishedAuction")) {
    for (const auction of flow.unfinishedAuctions) {
      const x0 = time.toPx(auction.barStartMs);
      const x1 = time.toPx(auction.barStartMs + barMs);
      const y = price.toPx(auction.priceTicks) + (auction.atHigh ? -rowHeight / 2 : rowHeight / 2);
      ctx.strokeStyle = colors.poc;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(Math.max(x0 + 6, x1), y);
      ctx.stroke();
      markers.push({
        x: (x0 + x1) / 2,
        y,
        r: Math.max(7, (x1 - x0) / 2),
        title: `Unfinished auction at the bar ${auction.atHigh ? "high" : "low"}`,
        lines: [formatTicks(auction.priceTicks, spec), `bid ${formatQty(auction.bidVolume)} × ask ${formatQty(auction.askVolume)}`],
      });
    }
  }
  if (m.isKindOn("Iceberg")) {
    for (const ice of flow.icebergs) {
      const x = Math.min(w - 6, time.toPx(ice.lastFillMs));
      const y = price.toPx(ice.priceTicks);
      const r = 4 + 6 * ice.confidence;
      ctx.fillStyle = ice.side === "Bid" ? colors.bid : colors.ask;
      ctx.globalAlpha = ice.active ? 1 : 0.55;
      ctx.strokeStyle = colors.strong;
      ctx.lineWidth = 1.5;
      diamond(ctx, x, y, r);
      ctx.fill();
      ctx.stroke();
      ctx.globalAlpha = 1;
      markers.push({
        x,
        y,
        r: r + 3,
        title: `${ice.side === "Bid" ? "Bid" : "Offer"} iceberg at ${formatTicks(ice.priceTicks, spec)}${ice.active ? "" : " (ended)"}`,
        lines: [
          `traded ${formatQty(ice.traded)} · peak displayed ${formatQty(ice.peakDisplayed)} · now ${formatQty(ice.displayed)}`,
          `refills ${ice.refills} (avg ${formatQty(ice.averageRefill)})`,
          `hidden ≥ ${formatQty(ice.hiddenEstimate)} · confidence ${formatPercent(ice.confidence)}`,
          "Inferred from prints and book changes, not exchange order ids",
          `first seen ${formatLocalTime(ice.firstSeenMs)} · last fill ${formatAge(m.market.serverTimeMs - ice.lastFillMs)} ago`,
        ],
      });
    }
  }
}

/** The y of every price tag already on the axis, so the line tags stack clear of them. */
function priceTagYs(m: MainChartModel, price: LinearScale): number[] {
  const { bestBid, bestAsk } = m.market.liquidity;
  const last = m.candles.at(-1)?.c;
  const inView = (v: number | null | undefined): v is number => v !== null && v !== undefined && v >= m.lowTicks && v <= m.highTicks;
  const ys: number[] = [];
  if (inView(bestBid)) ys.push(price.toPx(bestBid));
  if (inView(bestAsk)) ys.push(price.toPx(bestAsk));
  if (inView(last)) ys.push(Math.round(price.toPx(last)) + 0.5);
  return ys;
}

function drawPriceMarks(ctx: CanvasRenderingContext2D, m: MainChartModel, price: LinearScale, w: number) {
  const spec = m.market.instrument;
  ctx.font = fonts.xs;
  const { bestBid, bestAsk } = m.market.liquidity;
  if (bestBid !== null && bestBid !== undefined && bestBid >= m.lowTicks && bestBid <= m.highTicks) {
    labelBox(ctx, formatTicks(bestBid, spec), w + 2, price.toPx(bestBid), { fill: colors.bid, color: colors.onMarket });
  }
  if (bestAsk !== null && bestAsk !== undefined && bestAsk >= m.lowTicks && bestAsk <= m.highTicks) {
    labelBox(ctx, formatTicks(bestAsk, spec), w + 2, price.toPx(bestAsk), { fill: colors.ask, color: colors.onMarket });
  }
  const last = m.candles.at(-1)?.c;
  if (last !== undefined && last >= m.lowTicks && last <= m.highTicks) {
    const y = Math.round(price.toPx(last)) + 0.5;
    ctx.strokeStyle = colors.priceTag;
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = fonts.tag;
    labelBox(ctx, formatTicks(last, spec), w + 2, y, { fill: colors.priceTag, color: colors.onPriceTag });
  }
}

function drawWatermarks(ctx: CanvasRenderingContext2D, m: MainChartModel, time: LinearScale, w: number, h: number) {
  const code = m.market.status.code;
  if (code !== "LIVE") {
    ctx.save();
    ctx.fillStyle = tints.statusWatermark;
    ctx.font = `bold ${Math.max(28, Math.min(72, w / 10))}px ${MONO}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(code === "DEGRADED" ? "DEGRADED" : m.market.status.provenance, w / 2, h / 2);
    ctx.restore();
  }
  const mark = m.market.historyWatermarkMs;
  if (mark !== null && mark >= m.startMs && mark <= m.endMs) {
    const x = Math.round(time.toPx(mark)) + 0.5;
    ctx.strokeStyle = colors.muted;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = colors.muted;
    ctx.font = fonts.xs;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.textAlign = "right";
    ctx.fillText(HISTORY_WITHOUT_TAPE, x - 6, 12);
    ctx.textAlign = "left";
    ctx.fillText("live ▸", x + 4, h - 14);
  }
}

/** Draws the main chart and returns its scales and hover targets. */
export function drawMainChart(surface: Surface, m: MainChartModel): MainChartGeometry {
  const { ctx, width, height } = surface;
  const gutter = m.profile ? PROFILE_GUTTER : 0;
  const plotRight = Math.max(gutter + 10, width - AXIS_WIDTH);
  const h = Math.max(10, height - TIME_AXIS_HEIGHT);
  const time = linearScale(m.startMs, m.endMs, gutter, plotRight);
  const price = linearScale(m.lowTicks, m.highTicks, h, 0);
  const markers: Marker[] = [];

  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, width, height);
  drawProfileGutter(ctx, m, price, gutter, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(gutter, 0, plotRight - gutter, h);
  ctx.clip();
  drawWatermarks(ctx, m, time, plotRight, h);
  if (m.heatmap) {
    drawHeatmap(ctx, m, time, price, plotRight, h);
  }
  ctx.restore();
  // Over the heatmap: its ground is opaque, so a zone under it would never show.
  drawRangeZones(ctx, m.rangeZones ?? [], time, price, { x: gutter, y: 0, w: plotRight - gutter, h });
  drawGrid(ctx, m, time, price, plotRight, h);
  ctx.save();
  ctx.beginPath();
  ctx.rect(gutter, 0, plotRight - gutter, h);
  ctx.clip();
  if (m.profile) drawValueArea(ctx, m.profile, price, plotRight, m.hideValueArea === true);
  if (m.emphasizeNodes && m.profile) drawNodes(ctx, m, price, plotRight);
  drawKeyLevels(ctx, m, price, plotRight, markers);
  if (m.vwap) drawVwap(ctx, m, time, price, plotRight);
  // Dots off clears the boundary. Both layers off therefore still draws candles, so the chart is not blank.
  const tapeStart = m.showVolumeDots === false ? null : tapeBoundaryMs(m.market.historyWatermarkMs, m.market.prints);
  if (tapeStart !== null && tapeStart > m.startMs && tapeStart <= m.endMs) {
    const x = Math.round(time.toPx(tapeStart)) + 0.5;
    ctx.strokeStyle = colors.muted;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = colors.text;
    ctx.font = fonts.xs;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(TAPE_STARTS_HERE, x + 4, 28);
  }
  drawCandles(ctx, m, time, price, m.showCandles === true ? null : tapeStart);
  if (m.showVolumeDots !== false) drawVolumeDots(ctx, m, time, price);
  drawBbo(ctx, m, price, plotRight);
  drawLastTrade(ctx, m, time, price, plotRight);
  drawEmas(ctx, m, time, price);
  if (m.overlay) drawOverlay(ctx, m, price, plotRight, markers);
  drawOrderFlowState(ctx, m, time, price, plotRight, markers);
  drawSignals(ctx, m, time, price, plotRight, markers);
  ctx.restore();
  ctx.strokeStyle = colors.grid;
  ctx.strokeRect(gutter + 0.5, 0.5, plotRight - gutter, h);
  drawPriceMarks(ctx, m, price, plotRight);
  drawLineTags(ctx, m, price, plotRight, width, h, priceTagYs(m, price));
  return { plotLeft: gutter, plotWidth: plotRight, plotHeight: h, time, price, markers };
}

/** Draws the crosshair layer of the main chart: lines and the price and time readouts. */
export function drawMainCrosshair(
  surface: Surface,
  geometry: MainChartGeometry,
  spec: { readonly tickSize: number; readonly priceDecimals: number },
  timeMs: number | null,
  priceTicks: number | null,
): void {
  const { ctx } = surface;
  const { plotLeft, plotWidth: w, plotHeight: h, time, price } = geometry;
  ctx.strokeStyle = colors.crosshair;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.font = fonts.sm;
  if (timeMs !== null) {
    const x = Math.round(time.toPx(timeMs)) + 0.5;
    if (x >= plotLeft && x <= w) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      const text = `${formatLocalTime(timeMs)} · ${formatChicagoTime(timeMs)}`;
      const textWidth = ctx.measureText(text).width + 8;
      labelBox(ctx, text, Math.min(w - textWidth, Math.max(0, x - textWidth / 2)), (geometry.timeAxisTop ?? h) + 10, { fill: colors.chip, color: colors.strong });
    }
  }
  if (priceTicks !== null) {
    const y = Math.round(price.toPx(priceTicks)) + 0.5;
    if (y >= 0 && y <= h) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      labelBox(ctx, formatTicks(Math.round(priceTicks), spec), w + 2, y, { fill: colors.chip, color: colors.strong });
    }
  }
  ctx.setLineDash([]);
}

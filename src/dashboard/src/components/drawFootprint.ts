import type { Footprint } from "../api/schemas.ts";
import { composite, mostReadable, withAlpha } from "../design/color.ts";
import { decodeFootprint, footprintPoc, footprintRows, type FootprintCell } from "../domain/footprint.ts";
import { formatQty, formatSigned, formatTicks, type TickSpec } from "../domain/format.ts";
import { linearScale, type LinearScale } from "../domain/scale.ts";
import type { Surface } from "../lib/canvas.ts";
import { canvasFonts } from "../lib/canvasFonts.ts";
import { fnvHex, fnvStart, mix, mixNumbers } from "../lib/fnv.ts";
import { AXIS_WIDTH, canvasTheme, colors, fonts, perTheme, themeColor } from "../theme.ts";
import type { SeriesPaneGeometry } from "./drawSeriesPane.ts";

const DELTA_STRIP = 16;

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

/** Paints the pane's ground: the one colour the cell text is picked against. */
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

/** What the footprint pane draws. */
export interface FootprintModel {
  readonly startMs: number;
  readonly endMs: number;
  readonly bars: readonly Footprint[];
  readonly developing: Footprint | null;
  readonly spec: TickSpec;
  /** Dropped-trade holes. A bar that overlaps one is missing, including bars received before the range closed. */
  readonly missingRanges?: readonly (readonly (number | null | undefined)[])[];
  /** Minutes filled from a closed bar. A bar that overlaps one is approximate, even when it also overlaps a hole. */
  readonly approximateRanges?: readonly (readonly (number | null | undefined)[])[];
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
  readonly plotTop: number;
  readonly plotHeight: number;
  readonly rowHeight: number;
  readonly time: LinearScale;
  readonly rows: readonly number[];
  readonly rowIndex: ReadonlyMap<number, number>;
  readonly closed: readonly PaintedBar[];
  readonly developing: PaintedBar | null;
  readonly showText: boolean;
  readonly spec: TickSpec;
  readonly missingRanges: readonly (readonly (number | null | undefined)[])[];
  readonly approximateRanges: readonly (readonly (number | null | undefined)[])[];
}

interface FootprintCache {
  readonly key: string;
  readonly canvas: HTMLCanvasElement;
}

let footprintCache: FootprintCache | null = null;

/**
 * Closed bars plus the row layout, quantised to one pixel of the time window. The developing bar's volume is
 * left out, so a tick that does not add a price reuses the cached columns. Closed cells are mixed, not summed,
 * so two different bars cannot share a key. `fontEpoch` changes once the canvas fonts load, so cached text drawn in
 * the fallback face is not reused; `palette` is the canvas palette, so cells cached in one theme's colours, or before a
 * chart colour changed, are not either.
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
  const all = model.developing ? [...model.bars, model.developing] : model.bars;
  const visible = all.filter((bar) => bar.t + bar.d >= model.startMs && bar.t <= model.endMs);
  const rows = footprintRows(visible.map((bar) => decodeFootprint(bar)));
  let hash = fnvStart();
  hash = mix(hash, [
    width,
    height,
    globalThis.devicePixelRatio || 1,
    fontEpoch,
    palette,
    Math.round(model.startMs / quantum),
    Math.round(model.endMs / quantum),
    rows.join(","),
    model.spec.tickSize,
    model.spec.priceDecimals,
    (model.missingRanges ?? []).map((range) => range.join(":")).join(","),
    (model.approximateRanges ?? []).map((range) => range.join(":")).join(","),
  ]);
  let closed = 0;
  for (const bar of model.bars) {
    if (bar.t + bar.d < model.startMs || bar.t > model.endMs) continue;
    closed += 1;
    hash = mix(hash, [stampClosedBar(bar)]);
  }
  hash = mix(hash, [closed]);
  return fnvHex(hash);
}

function stampClosedBar(bar: Footprint): number {
  const cached = barStamp.get(bar);
  if (cached !== undefined) return cached;
  const hash = mixNumbers(mix(fnvStart(), [bar.t, bar.d, bar.delta, bar.v, bar.missing ? 1 : 0, bar.approximate ? 1 : 0]), bar.c);
  barStamp.set(bar, hash);
  return hash;
}

/**
 * Draws one footprint column per bar on the shared time axis. Rows are only the prices that traded in the visible
 * bars, highest first; a dashed line marks where untraded prices were skipped. Each row shows bid × ask, a
 * diagonal imbalance fills its side, the bar's POC is outlined and the bar delta sits underneath.
 * Closed columns are cached: a forming bar repaints only its own column.
 */
export function drawFootprint(surface: Surface, model: FootprintModel): SeriesPaneGeometry {
  const layout = layoutOf(surface, model);
  const key = footprintCacheKey(model, surface.width, surface.height);
  const cached = footprintCache?.key === key ? footprintCache.canvas : null;
  if (cached) {
    blit(surface.ctx, cached);
    surface.ctx.save();
    surface.ctx.beginPath();
    surface.ctx.rect(0, 0, layout.plotWidth, layout.height);
    surface.ctx.clip();
    if (layout.developing) drawBars(surface.ctx, [layout.developing], layout);
    drawSeparators(surface.ctx, layout);
    surface.ctx.restore();
    return { plotWidth: layout.plotWidth, time: layout.time };
  }

  const { ctx, width, height } = surface;
  paintGround(ctx, width, height);
  drawPlot(ctx, layout, true);
  remember(key, surface, layout);
  return { plotWidth: layout.plotWidth, time: layout.time };
}

function layoutOf(surface: Surface, model: FootprintModel): FootprintLayout {
  const plotWidth = Math.max(10, surface.width - AXIS_WIDTH);
  const time = linearScale(model.startMs, model.endMs, 0, plotWidth);
  const all = model.developing ? [...model.bars, model.developing] : model.bars;
  const visible = all.filter((bar) => bar.t + bar.d >= model.startMs && bar.t <= model.endMs);
  const decoded = visible.map((bar) => ({ bar, cells: decodeFootprint(bar), developing: bar === model.developing }));
  const rows = footprintRows(decoded.map((entry) => entry.cells));
  const plotTop = 16;
  const plotHeight = Math.max(10, surface.height - DELTA_STRIP - plotTop);
  const rowHeight = rows.length > 0 ? Math.min(18, plotHeight / rows.length) : plotHeight;
  return {
    width: surface.width,
    height: surface.height,
    plotWidth,
    plotTop,
    plotHeight,
    rowHeight,
    time,
    rows,
    rowIndex: new Map(rows.map((price, index) => [price, index])),
    closed: decoded.filter((entry) => !entry.developing),
    developing: decoded.find((entry) => entry.developing) ?? null,
    showText: rowHeight >= 9,
    spec: model.spec,
    missingRanges: model.missingRanges ?? [],
    approximateRanges: model.approximateRanges ?? [],
  };
}

function drawPlot(ctx: CanvasRenderingContext2D, layout: FootprintLayout, includeDeveloping: boolean): void {
  const bars = includeDeveloping && layout.developing ? [...layout.closed, layout.developing] : layout.closed;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, layout.plotWidth, layout.height);
  ctx.clip();
  drawBars(ctx, bars, layout);
  drawSeparators(ctx, layout);
  ctx.restore();
  drawAxis(ctx, layout);
}

function drawBars(ctx: CanvasRenderingContext2D, bars: readonly PaintedBar[], layout: FootprintLayout): void {
  for (const { bar, cells, developing } of bars) {
    const x0 = layout.time.toPx(bar.t) + 1;
    const x1 = layout.time.toPx(bar.t + bar.d) - 1;
    const colWidth = x1 - x0;
    if (colWidth < 1) continue;
    const split = layout.showText && colWidth >= 46;
    const half = colWidth / 2;
    const maxVolume = Math.max(1, ...cells.map((cell) => Math.max(cell.bid, cell.ask)));
    const poc = footprintPoc(cells);
    ctx.font = layout.rowHeight >= 13 ? fonts.sm : fonts.xs;
    ctx.textBaseline = "middle";
    for (const cell of cells) {
      const index = layout.rowIndex.get(cell.priceTicks);
      if (index === undefined) continue;
      const y = layout.plotTop + index * layout.rowHeight;
      if (split) {
        const sellShade = splitCellAlpha(cell.bid, maxVolume, cell.imbalance === -1);
        const buyShade = splitCellAlpha(cell.ask, maxVolume, cell.imbalance === 1);
        ctx.fillStyle = withAlpha(colors.down, sellShade);
        ctx.fillRect(x0, y, half - 0.5, layout.rowHeight - 1);
        ctx.fillStyle = withAlpha(colors.up, buyShade);
        ctx.fillRect(x0 + half + 0.5, y, half - 0.5, layout.rowHeight - 1);
        ctx.fillStyle = cellText()(colors.down, sellShade);
        ctx.textAlign = "right";
        ctx.fillText(formatQty(cell.bid), x0 + half - 3, y + layout.rowHeight / 2);
        ctx.fillStyle = cellText()(colors.up, buyShade);
        ctx.textAlign = "left";
        ctx.fillText(formatQty(cell.ask), x0 + half + 3, y + layout.rowHeight / 2);
      } else {
        const net = cell.ask - cell.bid;
        const alpha = 0.15 + 0.7 * (Math.abs(net) / maxVolume);
        ctx.fillStyle = withAlpha(net >= 0 ? colors.up : colors.down, alpha);
        ctx.fillRect(x0, y, colWidth, Math.max(1, layout.rowHeight - (layout.rowHeight > 3 ? 1 : 0)));
        if (cell.imbalance !== 0 && layout.rowHeight >= 3) {
          ctx.fillStyle = cell.imbalance === 1 ? colors.up : colors.down;
          ctx.fillRect(cell.imbalance === 1 ? x1 - 3 : x0, y, 3, Math.max(1, layout.rowHeight - 1));
        }
      }
      if (cell.priceTicks === poc) {
        ctx.strokeStyle = colors.poc;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x0 + 0.5, y + 0.5, colWidth - 1, Math.max(1, layout.rowHeight - 2));
      }
    }
    if (developing) {
      ctx.strokeStyle = colors.muted;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(x0 + 0.5, layout.plotTop + 0.5, colWidth - 1, layout.plotHeight - 1);
      ctx.setLineDash([]);
    }
    ctx.font = fonts.xs;
    ctx.textAlign = "center";
    ctx.fillStyle = bar.delta >= 0 ? colors.up : colors.down;
    // Ranges are replaced on every delta. A bar the client already holds is not, so the flag comes from the
    // ranges alone: a reload and a browser that has been on deltas then draw the same minutes.
    const approximate = barOverlapsMissing(bar.t, bar.d, layout.approximateRanges);
    const missing = !approximate && barOverlapsMissing(bar.t, bar.d, layout.missingRanges);
    const mark = approximate ? "≈" : missing ? "~" : "";
    if (colWidth >= 22) {
      ctx.fillText(mark.length > 0 ? `${mark} ${formatSigned(bar.delta)}` : formatSigned(bar.delta), x0 + colWidth / 2, layout.height - DELTA_STRIP / 2);
    } else if (mark.length > 0) {
      ctx.fillText(mark, x0 + colWidth / 2, layout.height - DELTA_STRIP / 2);
    } else {
      ctx.fillRect(x0, layout.height - DELTA_STRIP + 4, colWidth, DELTA_STRIP - 8);
    }
  }
}

function drawSeparators(ctx: CanvasRenderingContext2D, layout: FootprintLayout): void {
  ctx.strokeStyle = colors.muted;
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  for (let index = 1; index < layout.rows.length; index++) {
    const above = layout.rows[index - 1];
    const below = layout.rows[index];
    if (above !== undefined && below !== undefined && above - below > 1) {
      const y = Math.round(layout.plotTop + index * layout.rowHeight) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(layout.plotWidth, y);
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawAxis(ctx: CanvasRenderingContext2D, layout: FootprintLayout): void {
  ctx.font = fonts.xs;
  ctx.fillStyle = colors.axis;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const every = Math.max(1, Math.ceil(11 / Math.max(1, layout.rowHeight)));
  layout.rows.forEach((price, index) => {
    if (index % every === 0) {
      ctx.fillText(formatTicks(price, layout.spec), layout.plotWidth + 6, layout.plotTop + index * layout.rowHeight + layout.rowHeight / 2);
    }
  });
  ctx.font = fonts.sm;
  ctx.fillStyle = colors.text;
  ctx.textBaseline = "top";
  ctx.fillText(layout.rows.length === 0 ? "Footprint — no traded bars in view" : "Footprint (bid × ask, 1 min)", 4, 2);
  ctx.strokeStyle = colors.grid;
  ctx.strokeRect(0.5, 0.5, layout.plotWidth, layout.height - 1);
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
  drawPlot(ctx, layout, false);
  footprintCache = { key, canvas };
}

import { volumeStripBars, type VolumeStripBar } from "../domain/bookmap.ts";
import type { Candle } from "../domain/candles.ts";
import { formatQty } from "../domain/format.ts";
import { linearScale, niceTicks } from "../domain/scale.ts";
import { labelBox, type Surface } from "../lib/canvas.ts";
import { AXIS_WIDTH, colors, fonts } from "../theme.ts";
import type { SeriesPaneGeometry } from "./drawSeriesPane.ts";


/** One chart bar on the Volume tab: its traded volume, its sided share and whether it is warmup. */
export interface VolumePaneBar extends VolumeStripBar {
  readonly volume: number;
}

/**
 * Each chart bar's traded volume, warmup marked exactly as Order Flow's volume strip marked it before the dock took
 * its place: a bar that starts at or before the watermark has no aggressor side (REQUIREMENTS.md FR-61).
 */
export function volumePaneBars(candles: readonly Candle[], historyWatermarkMs: number | null): VolumePaneBar[] {
  return volumeStripBars(candles, historyWatermarkMs).map((bar, index) => ({
    ...bar,
    volume: Math.max(candles[index]?.v ?? 0, bar.buy + bar.sell),
  }));
}

/** What the Volume tab draws. */
export interface VolumePaneModel {
  readonly startMs: number;
  readonly endMs: number;
  readonly bars: readonly VolumePaneBar[];
  /** The width at the right for the value axis, `AXIS_WIDTH` when unset (see `SeriesPaneModel.axisWidth`). */
  readonly axisWidth?: number;
}

/**
 * The indicator dock's Volume tab on the chart's time axis, on Detail and Order Flow. A live bar is split into sell,
 * buy and any unsided rest; a warmup bar, and unsided volume, are the warmup grey and never up or down.
 */
export function drawVolumePane(surface: Surface, model: VolumePaneModel): SeriesPaneGeometry {
  const { ctx, width, height } = surface;
  const w = Math.max(10, width - (model.axisWidth ?? AXIS_WIDTH));
  const h = height;
  const time = linearScale(model.startMs, model.endMs, 0, w);
  const visible = model.bars.filter((bar) => bar.t + bar.d >= model.startMs && bar.t <= model.endMs);
  const max = Math.max(1, ...visible.map((bar) => bar.volume));
  const value = linearScale(0, max, h - 4, 14);

  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, width, height);
  ctx.font = fonts.xs;
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const ticks = niceTicks(0, max, Math.max(1, Math.floor(h / 28)), 0);
  for (const tick of ticks) {
    const y = Math.round(value.toPx(tick)) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
  ctx.fillStyle = colors.axis;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const tick of ticks) {
    ctx.fillText(formatQty(tick), w + 6, value.toPx(tick));
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  const zero = value.toPx(0);
  for (const bar of visible) {
    const x0 = time.toPx(bar.t);
    const barWidth = Math.max(1, time.toPx(bar.t + bar.d) - x0 - 1);
    const top = value.toPx(bar.volume);
    const total = zero - top;
    if (total <= 0) continue;
    if (bar.warmup) {
      ctx.fillStyle = colors.warmup;
      ctx.fillRect(x0, top, barWidth, total);
      continue;
    }
    const sellHeight = (bar.sell / bar.volume) * total;
    const buyHeight = (bar.buy / bar.volume) * total;
    const unsided = total - sellHeight - buyHeight;
    let y = top;
    if (unsided > 0) {
      ctx.fillStyle = colors.warmup;
      ctx.fillRect(x0, y, barWidth, unsided);
      y += unsided;
    }
    if (sellHeight > 0) {
      ctx.fillStyle = colors.aggressorSell;
      ctx.fillRect(x0, y, barWidth, sellHeight);
      y += sellHeight;
    }
    if (buyHeight > 0) {
      ctx.fillStyle = colors.aggressorBuy;
      ctx.fillRect(x0, y, barWidth, buyHeight);
    }
  }
  ctx.restore();

  const latest = visible.at(-1);
  const subtitle = latest ? `${formatQty(latest.volume)}${latest.warmup ? " (warmup, no side)" : ""}` : "no bars in view";
  ctx.font = fonts.sm;
  labelBox(ctx, `Volume  ${subtitle}`, 4, 9, { fill: colors.scrim, color: colors.text });
  ctx.strokeStyle = colors.grid;
  ctx.strokeRect(0.5, 0.5, w, h - 1);
  return { plotWidth: w, time };
}

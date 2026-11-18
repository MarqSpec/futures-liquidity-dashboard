import { fitRange, linearScale, niceTicks, type LinearScale } from "../domain/scale.ts";
import { withAlpha } from "../design/color.ts";
import { labelBox, type Surface } from "../lib/canvas.ts";
import { AXIS_WIDTH, canvasColors, colors, fonts, themed } from "../theme.ts";

// Alpha variants of the tokens, built once per theme.
const tints = themed((theme) => {
  const c = canvasColors(theme);
  return {
    histogramUp: withAlpha(c.up, 0.6),
    histogramDown: withAlpha(c.down, 0.6),
  };
});

/** A line through [timeMs, value] points. */
export interface SeriesLine {
  readonly points: readonly (readonly [number, number])[];
  readonly color: string;
  readonly width?: number;
}

/** Histogram bars at [timeMs, value], drawn `barMs` wide ending at their time. */
export interface SeriesHistogram {
  readonly points: readonly (readonly [number, number])[];
  readonly barMs: number;
}

/** One time-aligned indicator pane. */
export interface SeriesPaneModel {
  readonly startMs: number;
  readonly endMs: number;
  readonly title: string;
  /** Shown after the title, e.g. "warming up (8/14)" or the latest value. */
  readonly subtitle: string;
  readonly dimmed: boolean;
  readonly lines: readonly SeriesLine[];
  readonly histogram?: SeriesHistogram;
  /** A fixed value range (RSI 0–100); otherwise fitted to what is visible. */
  readonly range?: { readonly low: number; readonly high: number };
  /** Horizontal guides, e.g. 30/70 or 0. */
  readonly guides?: readonly number[];
  readonly format: (value: number) => string;
  /**
   * The width at the right for the value axis, `AXIS_WIDTH` when unset. Order Flow passes its PRICE, COB and SVP
   * columns' width, so the pane's time axis spans the plot above it.
   */
  readonly axisWidth?: number;
}

/** The time scale a series pane was drawn with. */
export interface SeriesPaneGeometry {
  readonly plotWidth: number;
  readonly time: LinearScale;
}

function visibleValues(model: SeriesPaneModel): number[] {
  const values: number[] = [];
  const inView = (t: number) => t >= model.startMs - 120_000 && t <= model.endMs + 120_000;
  for (const line of model.lines) {
    for (const [t, v] of line.points) if (inView(t)) values.push(v);
  }
  for (const [t, v] of model.histogram?.points ?? []) if (inView(t)) values.push(v);
  for (const g of model.guides ?? []) values.push(g);
  return values;
}

/** Draws a line/histogram pane on the shared time axis, with its own value axis on the right. */
export function drawSeriesPane(surface: Surface, model: SeriesPaneModel): SeriesPaneGeometry {
  const { ctx, width, height } = surface;
  const w = Math.max(10, width - (model.axisWidth ?? AXIS_WIDTH));
  const h = height;
  const time = linearScale(model.startMs, model.endMs, 0, w);
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, width, height);

  const range = model.range ?? fitRange(visibleValues(model), 0.08, 1e-9) ?? { low: -1, high: 1 };
  const value = linearScale(range.low, range.high, h - 4, 14);

  ctx.font = fonts.xs;
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const ticks = niceTicks(range.low, range.high, Math.max(1, Math.floor(h / 28)), 0);
  for (const t of ticks) {
    const y = Math.round(value.toPx(t)) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
  ctx.fillStyle = colors.axis;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const t of ticks) {
    ctx.fillText(model.format(t), w + 6, value.toPx(t));
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.globalAlpha = model.dimmed ? 0.45 : 1;
  for (const guide of model.guides ?? []) {
    const y = Math.round(value.toPx(guide)) + 0.5;
    ctx.strokeStyle = colors.muted;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (model.histogram) {
    const zero = value.toPx(0);
    for (const [t, v] of model.histogram.points) {
      const x1 = time.toPx(t);
      const x0 = time.toPx(t - model.histogram.barMs);
      if (x1 < 0 || x0 > w) continue;
      const y = value.toPx(v);
      ctx.fillStyle = v >= 0 ? tints.histogramUp : tints.histogramDown;
      ctx.fillRect(x0 + 1, Math.min(y, zero), Math.max(1, x1 - x0 - 2), Math.abs(zero - y));
    }
  }
  for (const line of model.lines) {
    ctx.strokeStyle = line.color;
    ctx.lineWidth = line.width ?? 1.3;
    ctx.beginPath();
    let started = false;
    for (const [t, v] of line.points) {
      if (t < model.startMs - 120_000) continue;
      const x = time.toPx(t);
      const y = value.toPx(v);
      if (started) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      started = true;
      if (t > model.endMs + 120_000) break;
    }
    ctx.stroke();
  }
  ctx.restore();

  ctx.font = fonts.sm;
  labelBox(ctx, `${model.title}  ${model.subtitle}`, 4, 9, { fill: colors.scrim, color: model.dimmed ? colors.muted : colors.text });
  ctx.strokeStyle = colors.grid;
  ctx.strokeRect(0.5, 0.5, w, h - 1);
  return { plotWidth: w, time };
}

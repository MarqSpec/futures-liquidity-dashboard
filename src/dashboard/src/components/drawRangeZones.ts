import type { RangeZone } from "../api/schemas.ts";
import { withAlpha } from "../design/color.ts";
import { RANGE_ZONE_FILL_ALPHA } from "../design/contrastFloors.ts";
import type { LinearScale } from "../domain/scale.ts";
import { themeColor, themed } from "../theme.ts";

// reference: REQUIREMENTS.md FR-75 (ARCHITECTURE.md D-62)

const tint = themed((theme) => {
  const zone = themeColor("range-zone", theme);
  return { fill: withAlpha(zone, RANGE_ZONE_FILL_ALPHA), edge: zone };
});

/** The plot rectangle a zone is clipped to, in CSS pixels. */
export interface RangeZonePlot {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Shades each range zone as a neutral box over its time, from half a tick under its low to half a tick over its high,
 * with a hairline top and bottom edge in `range-zone` and no label. Clipped to `plot`; call it before the price marks
 * so they draw over it. Left of `fillFromX` only the edges are drawn: Order Flow's warmup band already tints there.
 */
export function drawRangeZones(
  ctx: CanvasRenderingContext2D,
  zones: readonly RangeZone[],
  time: LinearScale,
  price: LinearScale,
  plot: RangeZonePlot,
  fillFromX = Number.NEGATIVE_INFINITY,
): void {
  if (zones.length === 0) return;
  const right = plot.x + plot.w;
  const shown = zones
    .map((zone) => {
      const a = price.toPx(zone.highTicks + 0.5);
      const b = price.toPx(zone.lowTicks - 0.5);
      return { x0: time.toPx(zone.startMs), x1: time.toPx(zone.endMs), top: Math.min(a, b), bottom: Math.max(a, b) };
    })
    .filter((box) => box.x1 > plot.x && box.x0 < right);
  if (shown.length === 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.x, plot.y, plot.w, plot.h);
  ctx.clip();
  ctx.fillStyle = tint.fill;
  for (const box of shown) {
    const x0 = Math.max(box.x0, fillFromX);
    if (box.x1 > x0) ctx.fillRect(x0, box.top, box.x1 - x0, box.bottom - box.top);
  }
  ctx.strokeStyle = tint.edge;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const box of shown) {
    for (const y of [Math.round(box.top) + 0.5, Math.round(box.bottom) - 0.5]) {
      ctx.moveTo(box.x0, y);
      ctx.lineTo(box.x1, y);
    }
  }
  ctx.stroke();
  ctx.restore();
}

import { withAlpha } from "../design/color.ts";
import type { ThemeId } from "../design/tokenFile.ts";
import { canvasColors, canvasTheme, themed } from "../theme.ts";

/** A canvas sized for the device pixel ratio, drawing in CSS pixels. */
export interface Surface {
  readonly ctx: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;
}

/**
 * Sizes `canvas` to `width`×`height` CSS pixels at the device pixel ratio, clears it, and returns a context that
 * draws in CSS pixels; null when there is nothing to draw on.
 */
export function prepareSurface(canvas: HTMLCanvasElement | null, width: number, height: number): Surface | null {
  if (!canvas || width <= 0 || height <= 0) {
    return null;
  }
  const ratio = globalThis.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * ratio);
  const pixelHeight = Math.round(height * ratio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

/** The hatch pattern made for each context, per theme: a pattern's tile is drawn once in one theme's colour. */
const patterns = new WeakMap<CanvasRenderingContext2D, Map<ThemeId, CanvasPattern | null>>();

/** The hatch's flat stand-in where no pattern can be made, and its stroke, in the active canvas theme. */
const hatch = themed((theme) => {
  const { muted } = canvasColors(theme);
  return { fill: withAlpha(muted, 0.35), stroke: withAlpha(muted, 0.55) };
});

/** A diagonal hatch for "not known" — distinct from empty, which is drawn as nothing. */
export function hatchPattern(ctx: CanvasRenderingContext2D): CanvasPattern | string {
  const theme = canvasTheme.current();
  const byTheme = patterns.get(ctx) ?? new Map<ThemeId, CanvasPattern | null>();
  patterns.set(ctx, byTheme);
  const cached = byTheme.get(theme);
  if (cached) {
    return cached;
  }
  if (typeof document === "undefined") {
    return hatch.fill;
  }
  const tile = document.createElement("canvas");
  tile.width = 6;
  tile.height = 6;
  const t = tile.getContext("2d");
  if (!t) {
    return hatch.fill;
  }
  t.strokeStyle = hatch.stroke;
  t.lineWidth = 1;
  t.beginPath();
  t.moveTo(0, 6);
  t.lineTo(6, 0);
  t.moveTo(-1, 1);
  t.lineTo(1, -1);
  t.moveTo(5, 7);
  t.lineTo(7, 5);
  t.stroke();
  const pattern = ctx.createPattern(tile, "repeat");
  byTheme.set(theme, pattern);
  return pattern ?? hatch.fill;
}

/** Draws a label in a filled box, clamped inside [0, maxX]; returns the box width. */
export function labelBox(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  options: { readonly fill: string; readonly color: string; readonly align?: "left" | "right"; readonly maxX?: number },
): number {
  const padding = 4;
  const width = ctx.measureText(text).width + padding * 2;
  const height = 15;
  let left = options.align === "right" ? x - width : x;
  if (options.maxX !== undefined) {
    left = Math.min(left, options.maxX - width);
  }
  left = Math.max(0, left);
  ctx.fillStyle = options.fill;
  ctx.fillRect(left, y - height / 2, width, height);
  ctx.fillStyle = options.color;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(text, left + padding, y + 0.5);
  return width;
}

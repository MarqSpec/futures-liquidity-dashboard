import { themeColor, themed } from "../theme.ts";

// The one outline every tab draws on a volume dot: its edge by aggressor side, green for buying and red for selling,
// part by part on a split dot, outside a thin halo of the dot's ink so it still shows on a bright heat cell.

const inks = themed((theme) => ({
  buy: themeColor("dot-outline-buy", theme),
  sell: themeColor("dot-outline-sell", theme),
  halo: themeColor("dot-outline-halo", theme),
}));

/** Width of the side outline, centred on the dot's edge. */
export const DOT_OUTLINE_WIDTH = 1.5;

/** Width of the halo, stroked just outside the outline. */
export const DOT_OUTLINE_HALO_WIDTH = 1;

/** The buy share starts at 12 o'clock and runs clockwise, as the buy slice is filled. */
const TOP = -Math.PI / 2;
const TURN = Math.PI * 2;

function arc(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, from: number, to: number, colour: string, width: number): void {
  ctx.beginPath();
  ctx.arc(x, y, radius, from, to);
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.stroke();
}

/**
 * Outlines the volume dot at (`x`, `y`) of `radius`: the arc of its buy share (`buyFraction`, 0–1) in
 * `dot-outline-buy` and the rest in `dot-outline-sell`, over a full-circle halo. Leaves the canvas state as it found it.
 */
export function strokeVolumeDotOutline(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, buyFraction: number): void {
  const split = TOP + TURN * Math.min(1, Math.max(0, buyFraction));
  ctx.save();
  ctx.globalAlpha = 1;
  arc(ctx, x, y, radius + DOT_OUTLINE_WIDTH / 2 + DOT_OUTLINE_HALO_WIDTH / 2, TOP, TOP + TURN, inks.halo, DOT_OUTLINE_HALO_WIDTH);
  if (split > TOP) arc(ctx, x, y, radius, TOP, split, inks.buy, DOT_OUTLINE_WIDTH);
  if (split < TOP + TURN) arc(ctx, x, y, radius, split, TOP + TURN, inks.sell, DOT_OUTLINE_WIDTH);
  ctx.restore();
}

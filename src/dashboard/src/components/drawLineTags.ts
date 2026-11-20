import { emaTag, LINE_TAG_HEIGHT, stackLineTags, vwapTags, type LineTagSpec } from "../domain/lineTags.ts";
import type { MarketState } from "../domain/merge.ts";
import type { LinearScale } from "../domain/scale.ts";
import { colors, emaColors, fonts } from "../theme.ts";

// reference: REQUIREMENTS.md FR-77, NFR-8 (ARCHITECTURE.md D-63)

/** What the line tags need of the main chart's model. */
export interface LineTagModel {
  readonly market: MarketState;
  readonly startMs: number;
  readonly endMs: number;
  readonly lowTicks: number;
  readonly highTicks: number;
  readonly emaIds: readonly string[];
  readonly vwap: boolean;
  /** Default on; the Layers toggle `line-tags` (REQUIREMENTS.md FR-9). */
  readonly lineTags?: boolean;
}

/** A line's own colour: VWAP and its bands take the VWAP token, an EMA its own. */
export function lineTagFill(key: string): string {
  return key.startsWith("vwap") ? colors.vwap : (emaColors[key] ?? colors.text);
}

/** The tags a model asks for, each at its line's right-edge price and inside the visible price range. */
export function lineTagSpecs(m: LineTagModel): readonly LineTagSpec[] {
  if (m.lineTags === false) return [];
  const specs: LineTagSpec[] = [];
  if (m.vwap) specs.push(...vwapTags(m.market.vwap));
  for (const id of m.emaIds) {
    const series = m.market.indicators.find((i) => i.id === id);
    const tag = series ? emaTag(series, { startMs: m.startMs, endMs: m.endMs, serverTimeMs: m.market.serverTimeMs }) : null;
    if (tag) specs.push(tag);
  }
  return specs.filter((tag) => tag.priceTicks >= m.lowTicks && tag.priceTicks <= m.highTicks);
}

/**
 * Names the overlay lines on the price axis, in each line's colour, stacked clear of each other and of `fixed` (the
 * y of the last-price, bid and ask tags). Drawn outside the plot clip, where those tags sit.
 */
export function drawLineTags(
  ctx: CanvasRenderingContext2D,
  m: LineTagModel,
  price: LinearScale,
  plotRight: number,
  canvasWidth: number,
  plotHeight: number,
  fixed: readonly number[],
): void {
  const specs = lineTagSpecs(m);
  if (specs.length === 0) return;
  const placed = stackLineTags(
    specs.map((tag) => ({ tag, y: price.toPx(tag.priceTicks) })),
    fixed,
    { top: 0, bottom: plotHeight },
  );
  ctx.font = fonts.xs;
  for (const tag of placed) drawTag(ctx, tag.text, lineTagFill(tag.key), plotRight + 2, tag.y, canvasWidth);
}

/**
 * One tag: the axis chip with the text in the strong ink (4.5:1 on the surfaces, NFR-8), and the line's colour as a bar
 * and an outline (3:1, the line floor), so the colour is the line's own without having to carry the text.
 */
function drawTag(ctx: CanvasRenderingContext2D, text: string, hue: string, x: number, y: number, canvasWidth: number): void {
  const padding = 4;
  const bar = 3;
  const width = ctx.measureText(text).width + padding * 2 + bar;
  const left = Math.max(0, Math.min(x, canvasWidth - width));
  const top = y - LINE_TAG_HEIGHT / 2;
  ctx.fillStyle = colors.chip;
  ctx.fillRect(left, top, width, LINE_TAG_HEIGHT);
  ctx.fillStyle = hue;
  ctx.fillRect(left, top, bar, LINE_TAG_HEIGHT);
  ctx.strokeStyle = hue;
  ctx.lineWidth = 1;
  ctx.strokeRect(left + 0.5, top + 0.5, width - 1, LINE_TAG_HEIGHT - 1);
  ctx.fillStyle = colors.strong;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(text, left + bar + padding, y + 0.5);
}

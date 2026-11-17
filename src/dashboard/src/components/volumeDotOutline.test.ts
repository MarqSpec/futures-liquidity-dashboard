import { afterEach, describe, expect, it } from "vitest";

import { color } from "../design/tokens.ts";
import { chartColorStore } from "../lib/chartColorOverrides.ts";
import { bookmapModel } from "../test/bookmapFixtures.ts";
import { model, quiet, start } from "../test/detailCanvasFixtures.ts";
import { fakeSurface, type CanvasCall } from "../test/fakeCanvas.ts";
import { canvasTheme } from "../theme.ts";
import { drawBookmap } from "./drawBookmap.ts";
import { drawMainChart } from "./drawMainChart.ts";
import { DOT_OUTLINE_HALO_WIDTH, DOT_OUTLINE_WIDTH, strokeVolumeDotOutline } from "./volumeDotOutline.ts";

// A volume dot is outlined by aggressor side, green for buying and red for selling, part by part on a split dot, over a
// thin halo, by one routine on every tab.

const TOP = -Math.PI / 2;
const FULL = TOP + Math.PI * 2;

afterEach(() => {
  chartColorStore.resetAll("dark");
  chartColorStore.resetAll("light");
  canvasTheme.set("dark");
});

/** One stroked arc: its colour, width and alpha, its centre, radius and the angles it spans. */
interface Ring {
  readonly colour: unknown;
  readonly width: unknown;
  readonly alpha: unknown;
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly from: number;
  readonly to: number;
}

/** Every stroke drawn in one of `colours`, with the arc it stroked. */
function rings(calls: readonly CanvasCall[], colours: readonly string[]): Ring[] {
  const found: Ring[] = [];
  let arc: readonly unknown[] | null = null;
  for (const call of calls) {
    if (call.method === "beginPath") arc = null;
    if (call.method === "arc") arc = call.args;
    if (call.method === "stroke" && arc !== null && colours.includes(String(call.strokeStyle))) {
      const [x, y, r, from, to] = arc as [number, number, number, number, number];
      found.push({ colour: call.strokeStyle, width: call.lineWidth, alpha: call.globalAlpha, x, y, r, from, to });
    }
  }
  return found;
}

/** The rings with their centre taken out, so a dot drawn on two tabs at two places compares equal. */
function shape(found: readonly Ring[]): Omit<Ring, "x" | "y">[] {
  return found.map(({ colour, width, alpha, r, from, to }) => ({ colour, width, alpha, r, from, to }));
}

function outlineColours(theme: "dark" | "light" = "dark"): string[] {
  return [color("dot-outline-buy", theme), color("dot-outline-sell", theme), color("dot-outline-halo", theme)];
}

/** The outline Detail draws on a lone print of `aggressor`: a dot of the largest radius. */
function detailOutline(aggressor: "Bid" | "Ask"): Ring[] {
  const { surface, calls } = fakeSurface();
  const print = { sourceTimeMs: start + 300_000, priceTicks: 100, quantity: 10, aggressor, sequence: 1 };
  drawMainChart(surface, model({ showVolumeDots: true, showCandles: false, market: quiet({ prints: [print] }) }));
  return rings(calls, outlineColours());
}

/** The outline Order Flow draws on one dot of the same radius, all buying (1) or all selling (0). */
function orderFlowOutline(buyFraction: number, radius = 10): Ring[] {
  const { surface, calls } = fakeSurface(1100, 640);
  const buy = Math.round(10 * buyFraction);
  drawBookmap(
    surface,
    bookmapModel({ dots: [{ timeMs: 70_000, priceTicks: 105, buy, sell: 10 - buy, total: 10, buyFraction, radius, label: false }] }),
  );
  return rings(calls, outlineColours());
}

describe("strokeVolumeDotOutline", () => {
  it("should stroke the whole edge in dot-outline-buy over a thin halo when the dot is all buying", () => {
    const { surface, calls } = fakeSurface();

    strokeVolumeDotOutline(surface.ctx, 50, 60, 8, 1);

    const halo = 8 + DOT_OUTLINE_WIDTH / 2 + DOT_OUTLINE_HALO_WIDTH / 2;
    expect(rings(calls, outlineColours())).toEqual([
      { colour: color("dot-outline-halo"), width: DOT_OUTLINE_HALO_WIDTH, alpha: 1, x: 50, y: 60, r: halo, from: TOP, to: FULL },
      { colour: color("dot-outline-buy"), width: DOT_OUTLINE_WIDTH, alpha: 1, x: 50, y: 60, r: 8, from: TOP, to: FULL },
    ]);
  });

  it("should stroke the whole edge in dot-outline-sell when the dot is all selling", () => {
    const { surface, calls } = fakeSurface();

    strokeVolumeDotOutline(surface.ctx, 50, 60, 8, 0);

    expect(rings(calls, [color("dot-outline-buy"), color("dot-outline-sell")])).toEqual([
      { colour: color("dot-outline-sell"), width: DOT_OUTLINE_WIDTH, alpha: 1, x: 50, y: 60, r: 8, from: TOP, to: FULL },
    ]);
  });

  it("should outline a split dot part by part: the buy share's edge green and the sell share's edge red", () => {
    const { surface, calls } = fakeSurface();

    strokeVolumeDotOutline(surface.ctx, 50, 60, 8, 0.25);

    const split = TOP + Math.PI * 2 * 0.25;
    expect(shape(rings(calls, [color("dot-outline-buy"), color("dot-outline-sell")]))).toEqual([
      { colour: color("dot-outline-buy"), width: DOT_OUTLINE_WIDTH, alpha: 1, r: 8, from: TOP, to: split },
      { colour: color("dot-outline-sell"), width: DOT_OUTLINE_WIDTH, alpha: 1, r: 8, from: split, to: FULL },
    ]);
  });

  it("should scope its canvas state and set its own line width and alpha when the caller left others set", () => {
    const { surface, calls } = fakeSurface();
    surface.ctx.lineWidth = 7;
    surface.ctx.globalAlpha = 0.5;

    strokeVolumeDotOutline(surface.ctx, 50, 60, 8, 0.5);

    expect(calls[0]?.method).toBe("save");
    expect(calls.at(-1)?.method).toBe("restore");
    expect(calls.filter((call) => call.method === "stroke").map((call) => [call.lineWidth, call.globalAlpha])).toEqual([
      [DOT_OUTLINE_HALO_WIDTH, 1],
      [DOT_OUTLINE_WIDTH, 1],
      [DOT_OUTLINE_WIDTH, 1],
    ]);
    expect(surface.ctx.lineWidth).toBe(7);
    expect(surface.ctx.globalAlpha).toBe(0.5);
  });

  it("should draw in the Light outline colours when the canvases draw in Light", () => {
    canvasTheme.set("light");
    const { surface, calls } = fakeSurface();

    strokeVolumeDotOutline(surface.ctx, 50, 60, 8, 0.5);

    expect(rings(calls, outlineColours("light")).map((ring) => ring.colour)).toEqual([
      color("dot-outline-halo", "light"),
      color("dot-outline-buy", "light"),
      color("dot-outline-sell", "light"),
    ]);
  });
});

describe("volume dot outlines on every tab", () => {
  it.each([
    ["Bid", 1],
    ["Ask", 0],
  ] as const)("should outline a %s dot the same way on Detail and Order Flow", (aggressor, buyFraction) => {
    const detail = detailOutline(aggressor);
    const orderFlow = orderFlowOutline(buyFraction);

    expect(detail.length).toBeGreaterThan(0);
    expect(shape(detail)).toEqual(shape(orderFlow));
  });

  it("should give a split Order Flow dot both colours, and draw the outline over the fill and under the quantity", () => {
    const { surface, calls } = fakeSurface(1100, 640);

    drawBookmap(surface, bookmapModel());

    const strokes = calls.map((call, index) => ({ call, index }));
    const outline = strokes.filter(({ call }) => call.method === "stroke" && outlineColours().includes(String(call.strokeStyle)));
    const fill = strokes.filter(({ call }) => call.method === "fill" && call.fillStyle === color("aggressor-buy")).at(-1);
    const label = strokes.find(({ call }) => call.method === "strokeText" && call.args[0] === "5,000");
    expect(new Set(outline.map(({ call }) => call.strokeStyle))).toEqual(new Set(outlineColours()));
    expect(outline.every(({ index }) => index > (fill?.index ?? Infinity) && index < (label?.index ?? -Infinity))).toBe(true);
  });

  it("should draw an overridden outline colour on both Detail and Order Flow", () => {
    chartColorStore.set("dark", "dot-outline-buy", "#123456");

    const { surface: detail, calls: detailCalls } = fakeSurface();
    const print = { sourceTimeMs: start + 300_000, priceTicks: 100, quantity: 10, aggressor: "Bid" as const, sequence: 1 };
    drawMainChart(detail, model({ showVolumeDots: true, market: quiet({ prints: [print] }) }));
    const { surface: orderFlow, calls: orderFlowCalls } = fakeSurface(1100, 640);
    drawBookmap(orderFlow, bookmapModel());

    expect(rings(detailCalls, ["#123456"])).toHaveLength(1);
    expect(rings(orderFlowCalls, ["#123456"])).toHaveLength(1);
  });
});

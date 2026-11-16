import { afterEach, describe, expect, it } from "vitest";

import { withAlpha } from "../design/color.ts";
import { color } from "../design/tokens.ts";
import { aggregateCandles } from "../domain/candles.ts";
import { formatTicks } from "../domain/format.ts";
import { heatScale } from "../domain/heat.ts";
import { bookmapColor, bookmapRgb } from "../domain/heatRamp.ts";
import { falling, market, model, profile, start } from "../test/detailCanvasFixtures.ts";
import { fakeSurface, type CanvasCall } from "../test/fakeCanvas.ts";
import { AXIS_WIDTH, canvasTheme } from "../theme.ts";
import { drawFootprint } from "./drawFootprint.ts";
import { drawMainChart, drawMainCrosshair } from "./drawMainChart.ts";
import { drawProfile } from "./drawProfile.ts";
import { drawSeriesPane, type SeriesPaneModel } from "./drawSeriesPane.ts";

// The Detail canvases draw every colour from the design tokens; Terminal keeps the market colours main drew.

function styles(calls: readonly CanvasCall[], method: string, key: "fillStyle" | "strokeStyle"): unknown[] {
  return calls.filter((call) => call.method === method).map((call) => call[key]);
}

function textColour(calls: readonly CanvasCall[], text: string): unknown {
  return calls.find((call) => call.method === "fillText" && call.args[0] === text)?.fillStyle;
}

describe("drawMainChart", () => {
  it("should fill a rising candle up and a falling candle down when candles are on", () => {
    const { surface, calls } = fakeSurface();

    drawMainChart(surface, model({ vwap: false }));

    const fills = styles(calls, "fillRect", "fillStyle");
    expect(fills).toContain(color("up"));
    expect(fills).toContain(color("down"));
  });

  it("should stroke the grid surface-highest and write the price axis on-surface-muted when it draws the axes", () => {
    const { surface, calls } = fakeSurface();

    drawMainChart(surface, model({ vwap: false }));

    expect(styles(calls, "stroke", "strokeStyle")[0]).toBe(color("surface-highest"));
    expect(calls.find((call) => call.method === "strokeRect")?.strokeStyle).toBe(color("surface-highest"));
    expect(textColour(calls, formatTicks(100, market.instrument))).toBe(color("on-surface-muted"));
  });

  it("should put the last price in a price-tag box on the axis with a dashed price-tag line when the close is in view", () => {
    const { surface, calls } = fakeSurface();
    const text = formatTicks(falling.c, market.instrument);
    const axisLeft = 800 - AXIS_WIDTH + 2;

    drawMainChart(surface, model({ vwap: false }));

    const box = calls.filter((call) => call.method === "fillRect" && call.fillStyle === color("price-tag"));
    expect(box).toHaveLength(1);
    expect(box[0]?.args[0]).toBe(axisLeft);
    expect(box[0]?.args[2]).toBe(text.length * 6 + 8);
    expect(box[0]?.args[3]).toBe(15);
    // The axis may print the same price as a grid tick; the tag is written last.
    expect(calls.filter((call) => call.method === "fillText" && call.args[0] === text).at(-1)?.fillStyle).toBe(color("on-price-tag"));
    const dashed = calls.findIndex((call) => call.method === "stroke" && call.strokeStyle === color("price-tag"));
    expect(dashed).toBeGreaterThan(-1);
    const lastDash = calls.slice(0, dashed).filter((call) => call.method === "setLineDash").at(-1);
    expect(lastDash?.args[0]).toEqual([2, 3]);
  });

  it("should draw no price tag when the last close is out of view", () => {
    const { surface, calls } = fakeSurface();

    drawMainChart(surface, model({ vwap: false, lowTicks: 200, highTicks: 240 }));

    expect(calls.some((call) => call.fillStyle === color("price-tag") || call.strokeStyle === color("price-tag"))).toBe(false);
  });

  it("should draw the VWAP, its band fill and its label from the vwap token when VWAP is on", () => {
    const { surface, calls } = fakeSurface();

    drawMainChart(surface, model());

    expect(styles(calls, "stroke", "strokeStyle")).toContain(color("vwap"));
    expect(styles(calls, "fill", "fillStyle")).toContain(withAlpha(color("vwap"), 0.07));
    expect(styles(calls, "fillRect", "fillStyle")).toContain(withAlpha(color("vwap"), 0.25));
    expect(styles(calls, "fillRect", "fillStyle")).toContain(withAlpha(color("vwap"), 0.18));
  });

  it("should stroke the best bid bid and the best ask ask when the quote is fresh", () => {
    // The quote is a side of the book, not a price direction: it never takes up or down.
    const fresh = fakeSurface();
    const stale = fakeSurface();

    drawMainChart(fresh.surface, model({ vwap: false, showCandles: false }));
    drawMainChart(stale.surface, model({ vwap: false, showCandles: false, market: { ...market, liquidity: { ...market.liquidity, quoteStale: true } } }));

    const before = new Set(styles(stale.calls, "stroke", "strokeStyle"));
    const quote = styles(fresh.calls, "stroke", "strokeStyle").filter((style) => !before.has(style));
    expect(quote).toEqual([color("bid"), color("ask")]);
  });

  it("should ground the heatmap in heat-0 when the heatmap is on", () => {
    const { surface, calls } = fakeSurface();
    const heat = market.heat;

    drawMainChart(
      surface,
      model({ market: market, candles: aggregateCandles(market.bars, market.developingBar, market.serverTimeMs), startMs: market.serverTimeMs - 300_000, endMs: market.serverTimeMs, lowTicks: 27_000, highTicks: 27_900, heatmap: true, heatColumns: heat, heatScale: heatScale(heat) }),
    );

    expect(styles(calls, "fillRect", "fillStyle")).toContain(color("heat-0"));
    expect(styles(calls, "fill", "fillStyle")).toContain(withAlpha(color("on-surface-muted"), 0.35));
  });

  it("should draw the nodes node-hvn and node-lvn and the profile gutter from its tokens when nodes are emphasised", () => {
    const { surface, calls } = fakeSurface();

    drawMainChart(surface, model({ vwap: false, profile, emphasizeNodes: true }));

    expect(textColour(calls, "HVN shelf")).toBe(color("node-hvn"));
    expect(textColour(calls, "LVN slidy zone")).toBe(color("node-lvn"));
    const fills = styles(calls, "fillRect", "fillStyle");
    expect(fills).toContain(color("surface-container"));
    expect(fills).toContain(withAlpha(color("node-hvn"), 0.95));
    expect(fills).toContain(withAlpha(color("node-lvn"), 0.85));
    expect(fills).toContain(withAlpha(color("value-area"), 0.75));
    expect(fills).toContain(withAlpha(color("highlight-single"), 0.45));
    expect(fills).toContain(withAlpha(color("value-area"), 0.08));
    expect(textColour(calls, "POC")).toBe(color("poc"));
    expect(textColour(calls, "session")).toBe(color("on-surface-muted"));
  });

  it("should mark a third touch last-price and other levels by side when key levels are drawn", () => {
    const { surface, calls } = fakeSurface();
    const levelTouches = [
      { name: "PDH", priceTicks: 110, isHigh: true, touches: 3, isThirdTouch: true },
      { name: "PDL", priceTicks: 85, isHigh: false, touches: 1, isThirdTouch: false },
    ];

    drawMainChart(surface, model({ vwap: false, levelTouches }));

    const strokes = styles(calls, "stroke", "strokeStyle");
    expect(strokes).toContain(withAlpha(color("last-price"), 0.95));
    // A low is drawn like support and a high like resistance, never in the price-direction pair.
    expect(strokes).toContain(withAlpha(color("support"), 0.55));
    expect(strokes).not.toContain(withAlpha(color("up"), 0.55));
    expect(textColour(calls, "PDH · 3rd")).toBe(color("last-price"));
    expect(textColour(calls, "PDL · 1")).toBe(color("on-surface-muted"));
  });
});

describe("drawMainChart key levels", () => {
  it("should stroke a high resistance and a low support when neither is a third touch", () => {
    const { surface, calls } = fakeSurface();
    const levelTouches = [
      { name: "PDH", priceTicks: 110, isHigh: true, touches: 1, isThirdTouch: false },
      { name: "PDL", priceTicks: 85, isHigh: false, touches: 1, isThirdTouch: false },
    ];

    drawMainChart(surface, model({ vwap: false, showCandles: false, levelTouches }));

    const strokes = styles(calls, "stroke", "strokeStyle");
    expect(strokes).toContain(withAlpha(color("resistance"), 0.55));
    expect(strokes).toContain(withAlpha(color("support"), 0.55));
    expect(strokes).not.toContain(withAlpha(color("down"), 0.55));
  });
});

describe("drawMainCrosshair", () => {
  it("should stroke the crosshair and box its readouts surface-highest when the pointer is over the plot", () => {
    const { surface } = fakeSurface();
    const geometry = drawMainChart(surface, model({ vwap: false }));
    const layer = fakeSurface();

    drawMainCrosshair(layer.surface, geometry, market.instrument, start + 120_000, 100);

    expect(styles(layer.calls, "stroke", "strokeStyle")).toEqual([color("crosshair"), color("crosshair")]);
    expect(styles(layer.calls, "fillRect", "fillStyle")).toEqual([color("surface-highest"), color("surface-highest")]);
    expect(textColour(layer.calls, formatTicks(100, market.instrument))).toBe(color("on-surface"));
  });
});

const pane: SeriesPaneModel = {
  startMs: start,
  endMs: start + 600_000,
  title: "CVD",
  subtitle: "+12",
  dimmed: false,
  lines: [],
  histogram: {
    points: [
      [start + 60_000, 5],
      [start + 120_000, -3],
    ],
    barMs: 60_000,
  },
  guides: [0],
  format: String,
};

describe("drawSeriesPane", () => {
  it("should fill positive bars up and negative bars down at 60% when it draws a histogram", () => {
    const { surface, calls } = fakeSurface();

    drawSeriesPane(surface, pane);

    const fills = styles(calls, "fillRect", "fillStyle");
    expect(fills).toContain(withAlpha(color("up"), 0.6));
    expect(fills).toContain(withAlpha(color("down"), 0.6));
  });

  it("should draw the grid, axis and title chip from the chrome tokens when it draws a pane", () => {
    const { surface, calls } = fakeSurface();

    drawSeriesPane(surface, pane);

    expect(styles(calls, "stroke", "strokeStyle")[0]).toBe(color("surface-highest"));
    expect(calls.find((call) => call.method === "strokeRect")?.strokeStyle).toBe(color("surface-highest"));
    expect(textColour(calls, "0")).toBe(color("on-surface-muted"));
    expect(styles(calls, "fillRect", "fillStyle")).toContain(color("scrim-chart"));
  });
});

describe("drawFootprint", () => {
  it("should fill every cell from the up and down channels and frame the plot surface-highest when bars are in view", () => {
    const { surface, calls } = fakeSurface(1200, 300);
    const bars = market.orderFlow.footprints;

    drawFootprint(surface, { startMs: (bars[0]?.t ?? 0) - 60_000, endMs: market.serverTimeMs, bars, developing: null, spec: market.instrument });

    const cells = styles(calls, "fillRect", "fillStyle").filter((style) => String(style).startsWith("rgba("));
    const up = withAlpha(color("up"), 0).replace(/0\)$/, "");
    const down = withAlpha(color("down"), 0).replace(/0\)$/, "");
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((style) => String(style).startsWith(up) || String(style).startsWith(down))).toBe(true);
    expect(calls.find((call) => call.method === "strokeRect" && call.args[0] === 0.5)?.strokeStyle).toBe(color("surface-highest"));
  });
});

describe("drawProfile", () => {
  it("should fill the POC poc, the value area value-area and the rest from reference when it draws the bins", () => {
    const { surface, calls } = fakeSurface(240, 300);

    drawProfile(surface, profile, market.instrument, 100);

    const fills = styles(calls, "fillRect", "fillStyle");
    expect(fills).toContain(color("poc"));
    expect(fills).toContain(withAlpha(color("value-area"), 0.75));
    expect(fills).toContain(withAlpha(color("reference"), 0.55));
    expect(fills).toContain(color("scrim-chart"));
    expect(styles(calls, "stroke", "strokeStyle")).toContain(color("last-price"));
  });

  it("should mark an HVN node-hvn and an LVN node-lvn when the profile has nodes", () => {
    const { surface, calls } = fakeSurface(240, 300);

    drawProfile(surface, profile, market.instrument, 100);

    expect(textColour(calls, "▶")).toBe(color("node-hvn"));
    expect(textColour(calls, "▷")).toBe(color("node-lvn"));
  });

  it("should say there is no volume yet in on-surface-muted when the profile is empty", () => {
    const { surface, calls } = fakeSurface(240, 300);

    drawProfile(surface, { ...profile, bins: [] }, market.instrument, null);

    expect(textColour(calls, "no volume yet")).toBe(color("on-surface-muted"));
  });
});

describe("bookmapRgb", () => {
  it("should start at heat-0 and end at heat-100 when t runs from 0 to 1", () => {
    expect(withAlpha(color("heat-0"), 1)).toBe(`rgba(${bookmapRgb(0).join(", ")}, 1)`);
    expect(withAlpha(color("heat-100"), 1)).toBe(`rgba(${bookmapRgb(1).join(", ")}, 1)`);
  });

  it("should pass through heat-25, heat-50 and heat-75 when t is on a stop", () => {
    expect(withAlpha(color("heat-25"), 1)).toBe(`rgba(${bookmapRgb(0.25).join(", ")}, 1)`);
    expect(withAlpha(color("heat-50"), 1)).toBe(`rgba(${bookmapRgb(0.5).join(", ")}, 1)`);
    expect(withAlpha(color("heat-75"), 1)).toBe(`rgba(${bookmapRgb(0.75).join(", ")}, 1)`);
  });
});

// The colours main drew, as literals: Terminal must not move them ("compare against main").
describe("Terminal market colours", () => {
  it("should draw the market colours main drew when the theme is Terminal", () => {
    // Up and down are the one deliberate move since main: blue and grey.
    expect(withAlpha(color("up"), 0.6)).toBe("rgba(111, 132, 255, 0.6)");
    expect(withAlpha(color("down"), 0.85)).toBe("rgba(176, 176, 176, 0.85)");
    expect(withAlpha(color("vwap"), 0.07)).toBe("rgba(224, 64, 251, 0.07)");
    expect(withAlpha(color("last-price"), 0.95)).toBe("rgba(255, 213, 79, 0.95)");
    expect(withAlpha(color("node-lvn"), 0.85)).toBe("rgba(79, 195, 247, 0.85)");
    expect(withAlpha(color("poc"), 0.9)).toBe("rgba(255, 202, 40, 0.9)");
    expect(withAlpha(color("value-area"), 0.08)).toBe("rgba(126, 87, 194, 0.08)");
    expect(withAlpha(color("highlight-single"), 0.45)).toBe("rgba(144, 164, 174, 0.45)");
    expect(withAlpha(color("reference"), 0.55)).toBe("rgba(120, 144, 156, 0.55)");
    expect([color("up"), color("down"), color("node-hvn"), color("node-lvn"), color("heat-0")]).toEqual(["#6f84ff", "#b0b0b0", "#ffd54f", "#4fc3f7", "#000000"]);
    expect([0, 0.25, 0.5, 0.75, 1].map((t) => bookmapColor(t, 1))).toEqual([
      "rgba(0, 0, 0, 1.000)",
      "rgba(20, 60, 220, 1.000)",
      "rgba(250, 230, 40, 1.000)",
      "rgba(255, 140, 0, 1.000)",
      "rgba(220, 30, 20, 1.000)",
    ]);
  });
});

// Light: every Detail canvas reads the active theme's token values, alpha variants included.
describe("Detail canvases in Light", () => {
  afterEach(() => canvasTheme.set("dark"));

  it("should draw the main chart's grid, VWAP band and price tag from the Light values when the theme is Light", () => {
    canvasTheme.set("light");
    const { surface, calls } = fakeSurface();

    drawMainChart(surface, model());

    expect(styles(calls, "stroke", "strokeStyle")[0]).toBe(color("surface-highest", "light"));
    expect(styles(calls, "fill", "fillStyle")).toContain(withAlpha(color("vwap", "light"), 0.07));
    expect(styles(calls, "fillRect", "fillStyle")).toContain(color("price-tag", "light"));
    expect(styles(calls, "fill", "fillStyle")).not.toContain(withAlpha(color("vwap"), 0.07));
  });

  it("should ground the heatmap in warm paper and hatch unknown depth in the Light muted grey when the theme is Light", () => {
    canvasTheme.set("light");
    const { surface, calls } = fakeSurface();
    const heat = market.heat;

    drawMainChart(
      surface,
      model({ market: market, candles: aggregateCandles(market.bars, market.developingBar, market.serverTimeMs), startMs: market.serverTimeMs - 300_000, endMs: market.serverTimeMs, lowTicks: 27_000, highTicks: 27_900, heatmap: true, heatColumns: heat, heatScale: heatScale(heat) }),
    );

    expect(styles(calls, "fillRect", "fillStyle")).toContain("#efede7");
    expect(styles(calls, "fill", "fillStyle")).toContain(withAlpha(color("on-surface-muted", "light"), 0.35));
  });

  it("should fill an indicator histogram and the profile bins from the Light values when the theme is Light", () => {
    canvasTheme.set("light");
    const series = fakeSurface();
    const bins = fakeSurface(240, 300);

    drawSeriesPane(series.surface, pane);
    drawProfile(bins.surface, profile, market.instrument, 100);

    expect(styles(series.calls, "fillRect", "fillStyle")).toContain(withAlpha(color("up", "light"), 0.6));
    expect(styles(bins.calls, "fillRect", "fillStyle")).toContain(withAlpha(color("reference", "light"), 0.55));
    expect(styles(bins.calls, "fillRect", "fillStyle")).toContain(withAlpha(color("value-area", "light"), 0.75));
  });

  it("should map heat on the Light ramp when a heat colour is asked for in Light", () => {
    canvasTheme.set("light");

    expect(bookmapColor(0, 1)).toBe("rgba(239, 237, 231, 1.000)");
  });
});

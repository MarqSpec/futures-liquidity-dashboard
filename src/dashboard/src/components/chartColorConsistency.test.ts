// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { rgbChannels, withAlpha } from "../design/color.ts";
import { color } from "../design/tokens.ts";
import { bookmapRgb } from "../domain/heatRamp.ts";
import { biasColors, eventMarker } from "../domain/signals.ts";
import { chartColorStore } from "../lib/chartColorOverrides.ts";
import { bookmapModel } from "../test/bookmapFixtures.ts";
import { market, model } from "../test/detailCanvasFixtures.ts";
import { fakeSurface, type CanvasCall } from "../test/fakeCanvas.ts";
import { applyDocumentChartColors, canvasTheme, colors, indicatorColors } from "../theme.ts";
import { drawBookmap } from "./drawBookmap.ts";
import { drawFootprint } from "./drawFootprint.ts";
import { drawMainChart } from "./drawMainChart.ts";

// One role, one colour, on every tab: an override reaches Detail, Order Flow, Overview, the indicator dock and the side
// column through the one override layer, and the colours derived from a role follow it.

const UP = "#123456";
const BID = "#a0522d";

afterEach(() => {
  chartColorStore.resetAll("dark");
  chartColorStore.resetAll("light");
  canvasTheme.set("dark");
  document.documentElement.removeAttribute("style");
});

function used(calls: readonly CanvasCall[], colour: string): boolean {
  return calls.some((call) => call.fillStyle === colour || call.strokeStyle === colour);
}

/** What the Detail main chart, the Order Flow chart and the Overview stylesheet draw `token` in. */
function acrossTabs(token: string): { detail: CanvasCall[]; orderFlow: CanvasCall[]; overview: string } {
  const detail = fakeSurface();
  drawMainChart(detail.surface, model({ vwap: false }));
  const orderFlow = fakeSurface(1100, 640);
  drawBookmap(orderFlow.surface, bookmapModel());
  applyDocumentChartColors(document, canvasTheme.current());
  return { detail: detail.calls, orderFlow: orderFlow.calls, overview: document.documentElement.style.getPropertyValue(`--${token}`) };
}

describe("chart colour overrides across tabs", () => {
  it("should draw an overridden up in the same colour on Detail, Order Flow, Overview and the indicator dock", () => {
    chartColorStore.set("dark", "up", UP);

    const { detail, orderFlow, overview } = acrossTabs("up");

    expect(used(detail, UP)).toBe(true);
    expect(used(orderFlow, UP)).toBe(true);
    expect(overview).toBe(UP);
    expect(colors.up).toBe(UP);
    expect(biasColors.Bullish).toBe(UP);
    expect(used(detail, color("up"))).toBe(false);
    expect(used(orderFlow, color("up"))).toBe(false);
  });

  it("should draw an overridden bid in the same colour on Detail, Order Flow, Overview and the CVD line", () => {
    chartColorStore.set("dark", "bid", BID);

    const { detail, orderFlow, overview } = acrossTabs("bid");

    expect(used(detail, BID)).toBe(true);
    expect(used(orderFlow, BID)).toBe(true);
    expect(overview).toBe(BID);
    expect(colors.bid).toBe(BID);
    expect(colors.bidRgb).toBe(rgbChannels(BID).join(", "));
  });

  it("should leave the other theme on its defaults and apply its own override when the theme switches", () => {
    chartColorStore.set("light", "up", UP);

    expect(colors.up).toBe(color("up", "dark"));
    canvasTheme.set("light");

    expect(colors.up).toBe(UP);
    expect(acrossTabs("up").overview).toBe(UP);
  });

  it("should take every role back to its theme default when it is reset", () => {
    chartColorStore.set("dark", "up", UP);
    acrossTabs("up");

    chartColorStore.reset("dark", "up");
    const { detail, overview } = acrossTabs("up");

    expect(colors.up).toBe(color("up"));
    expect(used(detail, UP)).toBe(false);
    expect(overview).toBe("");
  });

  it("should read every line of the indicator dock and every event marker through the overrides", () => {
    chartColorStore.set("dark", "indicator-rsi", "#010203");
    chartColorStore.set("dark", "event-spoof", "#040506");

    expect(indicatorColors.rsi).toBe("#010203");
    expect(eventMarker("Spoof").color).toBe("#040506");
  });
});

describe("colours derived from an overridden role", () => {
  it("should shade split footprint cells from the overridden up and down", () => {
    chartColorStore.set("dark", "up", UP);
    chartColorStore.set("dark", "down", "#654321");
    const { surface, calls } = fakeSurface(1200, 300);
    const bars = market.orderFlow.footprints;

    drawFootprint(surface, { startMs: (bars[0]?.t ?? 0) - 60_000, endMs: market.serverTimeMs, bars, developing: null, spec: market.instrument });

    const cells = calls.filter((call) => call.method === "fillRect" && String(call.fillStyle).startsWith("rgba(")).map((call) => String(call.fillStyle));
    const up = withAlpha(UP, 0).replace(/0\)$/, "");
    const down = withAlpha("#654321", 0).replace(/0\)$/, "");
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((style) => style.startsWith(up) || style.startsWith(down))).toBe(true);
  });

  it("should pick the footprint cell text again on the overridden shades", () => {
    // In Light the deep grey imbalance shades take the light ink; white shades take the theme's dark text back.
    canvasTheme.set("light");
    const bars = market.orderFlow.footprints;
    const lightInk = () => {
      const { surface, calls } = fakeSurface(1200, 300);
      drawFootprint(surface, { startMs: (bars[0]?.t ?? 0) - 60_000, endMs: market.serverTimeMs, bars, developing: null, spec: market.instrument });
      return calls.filter((call) => call.method === "fillText" && call.fillStyle === color("surface-lowest", "light")).length;
    };
    const plain = lightInk();
    chartColorStore.set("light", "up", "#ffffff");
    chartColorStore.set("light", "down", "#ffffff");

    expect(plain).toBeGreaterThan(0);
    expect(lightInk()).toBeLessThan(plain);
  });

  it("should blend the heat ramp between the overridden stops", () => {
    chartColorStore.set("dark", "heat-25", "#000080");
    chartColorStore.set("dark", "heat-50", "#0000ff");

    expect(bookmapRgb(0.5)).toEqual(rgbChannels("#0000ff"));
    expect(bookmapRgb(0.375)).toEqual([0, 0, 192]);
  });

  it("should halo an overridden dark price line in the light ink on the Order Flow chart", () => {
    chartColorStore.set("dark", "price-line", "#101010");
    const { surface, calls } = fakeSurface(1100, 640);

    drawBookmap(
      surface,
      bookmapModel({ showPriceLine: true, priceSteps: [{ timeMs: 40_000, priceTicks: 100 }, { timeMs: 100_000, priceTicks: 104 }] }),
    );

    const halo = calls.find((call) => call.method === "stroke" && call.lineWidth === 3.25 && call.strokeStyle !== color("price-line-halo-warmup"));
    expect(halo?.strokeStyle).toBe(color("price-line"));
    expect(calls.some((call) => call.method === "stroke" && call.strokeStyle === "#101010")).toBe(true);
  });

  it("should print a volume dot's quantity in the ink that reads on the overridden slices", () => {
    chartColorStore.set("dark", "up", "#101820");
    chartColorStore.set("dark", "down", "#202020");
    const { surface, calls } = fakeSurface(1100, 640);

    drawBookmap(surface, bookmapModel());

    const label = calls.find((call) => call.method === "fillText" && call.args[0] === "5,000");
    expect(label?.fillStyle).toBe(color("dot-label-halo"));
  });
});

describe("canvas palette", () => {
  it("should name the bare theme when nothing is overridden, so cached frames stay valid", () => {
    expect(canvasTheme.palette()).toBe("dark");
  });

  it("should change the palette and tell each canvas once when a colour changes", () => {
    const listener = vi.fn();
    const unsubscribe = canvasTheme.subscribe(listener);

    chartColorStore.set("dark", "up", UP);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(canvasTheme.palette()).not.toBe("dark");
    unsubscribe();
  });

  it("should keep the palette when only the other theme's colours change", () => {
    chartColorStore.set("light", "up", UP);

    expect(canvasTheme.palette()).toBe("dark");
  });
});

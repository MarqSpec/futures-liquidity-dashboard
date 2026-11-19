import { afterEach, describe, expect, it } from "vitest";

import type { Footprint, RangeZone } from "../api/schemas.ts";
import { withAlpha } from "../design/color.ts";
import { RANGE_ZONE_FILL_ALPHA, WARMUP_BAND_ALPHA } from "../design/contrastFloors.ts";
import { color } from "../design/tokens.ts";
import { aggregateCandles } from "../domain/candles.ts";
import { heatScale } from "../domain/heat.ts";
import { fromSnapshot } from "../domain/merge.ts";
import { linearScale } from "../domain/scale.ts";
import { bookmapModel } from "../test/bookmapFixtures.ts";
import { fakeSurface, type CanvasCall } from "../test/fakeCanvas.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { canvasTheme, colors } from "../theme.ts";
import { mainChartDrawKey } from "./chartDrawKey.ts";
import { drawBookmap } from "./drawBookmap.ts";
import { drawFootprint, footprintCacheKey, type FootprintModel } from "./drawFootprint.ts";
import { drawMainChart, type MainChartModel } from "./drawMainChart.ts";
import { drawRangeZones } from "./drawRangeZones.ts";

// reference: REQUIREMENTS.md FR-75, NFR-8 (ARCHITECTURE.md D-62)

afterEach(() => canvasTheme.set("dark"));

const fill = () => withAlpha(color("range-zone"), RANGE_ZONE_FILL_ALPHA);
const edge = () => color("range-zone");
const zoneFills = (calls: readonly CanvasCall[]) => calls.filter((call) => call.method === "fillRect" && call.fillStyle === fill());
const firstIndex = (calls: readonly CanvasCall[], test: (call: CanvasCall) => boolean) => calls.findIndex(test);

describe("drawRangeZones", () => {
  const time = linearScale(0, 1000, 0, 100);
  const price = linearScale(0, 100, 200, 0);
  const plot = { x: 0, y: 0, w: 100, h: 200 };
  const zone: RangeZone = { startMs: 200, endMs: 600, lowTicks: 40, highTicks: 60 };

  it("should fill the zone between its low and high over its time, half a tick past each extreme", () => {
    const { surface, calls } = fakeSurface();

    drawRangeZones(surface.ctx, [zone], time, price, plot);

    const [rect] = zoneFills(calls);
    expect(rect?.args).toEqual([20, price.toPx(60.5), 40, price.toPx(39.5) - price.toPx(60.5)]);
  });

  it("should stroke a hairline top and bottom edge in the range-zone token and no side edges", () => {
    const { surface, calls } = fakeSurface();

    drawRangeZones(surface.ctx, [zone], time, price, plot);

    const strokes = calls.filter((call) => call.method === "stroke");
    expect(strokes).toHaveLength(1);
    expect(strokes[0]?.strokeStyle).toBe(edge());
    expect(strokes[0]?.lineWidth).toBe(1);
    const lines = calls.filter((call) => call.method === "lineTo");
    expect(lines.map((call) => call.args[0])).toEqual([60, 60]);
    expect(new Set(lines.map((call) => call.args[1])).size).toBe(2);
  });

  it("should clip to the plot and draw no label", () => {
    const { surface, calls } = fakeSurface();

    drawRangeZones(surface.ctx, [zone], time, price, plot);

    const clip = firstIndex(calls, (call) => call.method === "clip");
    expect(clip).toBeGreaterThan(-1);
    expect(clip).toBeLessThan(firstIndex(calls, (call) => call.method === "fillRect"));
    expect(calls.some((call) => call.method === "fillText" || call.method === "strokeText")).toBe(false);
    expect(calls.at(-1)?.method).toBe("restore");
  });

  it("should skip a zone outside the window and draw nothing for no zones", () => {
    const outside = fakeSurface();
    drawRangeZones(outside.surface.ctx, [{ ...zone, startMs: 2000, endMs: 3000 }], time, price, plot);
    expect(zoneFills(outside.calls)).toHaveLength(0);

    const none = fakeSurface();
    drawRangeZones(none.surface.ctx, [], time, price, plot);
    expect(none.calls).toHaveLength(0);
  });

  it("should leave the fill out left of fillFromX and keep the edges across it", () => {
    const { surface, calls } = fakeSurface();

    drawRangeZones(surface.ctx, [zone], time, price, plot, 40);

    expect(zoneFills(calls)[0]?.args[0]).toBe(40);
    expect(zoneFills(calls)[0]?.args[2]).toBe(20);
    expect(calls.filter((call) => call.method === "moveTo").map((call) => call.args[0])).toEqual([20, 20]);
  });

  it("should use the Light token when the canvas theme is Light", () => {
    canvasTheme.set("light");
    const { surface, calls } = fakeSurface();

    drawRangeZones(surface.ctx, [zone], time, price, plot);

    const light = withAlpha(color("range-zone", "light"), RANGE_ZONE_FILL_ALPHA);
    expect(calls.some((call) => call.method === "fillRect" && call.fillStyle === light)).toBe(true);
  });
});

const market = fromSnapshot(snapshotFixture(), 5, 0);
const candles = aggregateCandles(market.bars, market.developingBar, market.serverTimeMs);
const visible = candles.filter((c) => c.t + c.d >= market.serverTimeMs - 5 * 60_000);
const low = Math.min(...visible.map((c) => c.l ?? Infinity));
const high = Math.max(...visible.map((c) => c.h ?? -Infinity));
const chartZone: RangeZone = { startMs: market.serverTimeMs - 4 * 60_000, endMs: market.serverTimeMs - 60_000, lowTicks: low, highTicks: high };

function chart(overrides: Partial<MainChartModel> = {}): MainChartModel {
  return {
    market,
    candles,
    startMs: market.serverTimeMs - 5 * 60_000,
    endMs: market.serverTimeMs + 10_000,
    lowTicks: low - 10,
    highTicks: high + 10,
    heatmap: true,
    heatColumns: market.heat,
    heatMode: "intensity",
    heatContrast: 1,
    heatScale: heatScale(market.heat),
    showCandles: true,
    levelTouches: [],
    profile: null,
    emaIds: [],
    vwap: false,
    overlay: false,
    signals: [],
    isKindOn: () => true,
    ...overrides,
  };
}

describe("drawMainChart range zones", () => {
  it("should draw a zone over the heatmap's ground and under the candles", () => {
    const { surface, calls } = fakeSurface();

    drawMainChart(surface, chart({ rangeZones: [chartZone] }));

    const zone = firstIndex(calls, (call) => call.method === "fillRect" && call.fillStyle === fill());
    const ground = firstIndex(calls, (call) => call.method === "fillRect" && call.fillStyle === colors.heatGround);
    const candle = firstIndex(calls, (call) => call.method === "fillRect" && (call.fillStyle === colors.up || call.fillStyle === colors.down));
    expect(ground).toBeGreaterThan(-1);
    expect(zone).toBeGreaterThan(ground);
    expect(candle).toBeGreaterThan(zone);
  });

  it("should keep the price scale and draw no zone when the model has none", () => {
    const withZone = fakeSurface();
    const without = fakeSurface();

    const shaded = drawMainChart(withZone.surface, chart({ rangeZones: [{ ...chartZone, lowTicks: low - 500, highTicks: high + 500 }] }));
    const plain = drawMainChart(without.surface, chart());

    expect(shaded.price.toPx(low)).toBe(plain.price.toPx(low));
    expect(zoneFills(withZone.calls)).toHaveLength(1);
    expect(zoneFills(without.calls)).toHaveLength(0);
  });

  it("should change the draw key when a zone grows", () => {
    const before = mainChartDrawKey(chart({ rangeZones: [chartZone] }), 800, 400);
    const after = mainChartDrawKey(chart({ rangeZones: [{ ...chartZone, endMs: chartZone.endMs + 60_000 }] }), 800, 400);

    expect(after).not.toBe(before);
  });
});

describe("drawFootprint range zones", () => {
  const bar = (market.orderFlow.footprints.at(-1) ?? market.orderFlow.developingFootprint) as Footprint;
  const barLow = bar.l ?? 0;
  const barHigh = bar.h ?? 0;
  const footprint = (overrides: Partial<FootprintModel> = {}): FootprintModel => ({
    startMs: bar.t - 60_000,
    endMs: bar.t + bar.d + 60_000,
    lowTicks: barLow - 5,
    highTicks: barHigh + 5,
    bars: [bar],
    developing: null,
    spec: market.instrument,
    ...overrides,
  });
  const zone: RangeZone = { startMs: bar.t - 30_000, endMs: bar.t + bar.d, lowTicks: barLow, highTicks: barHigh };

  it("should draw a zone over the ground and before the footprint's cells", () => {
    const { surface, calls } = fakeSurface();

    drawFootprint(surface, footprint({ rangeZones: [zone] }));

    const shaded = firstIndex(calls, (call) => call.method === "fillRect" && call.fillStyle === fill());
    expect(shaded).toBeGreaterThan(0);
    const cell = calls.findIndex((call, index) => index > shaded && (call.method === "fillRect" || call.method === "fill") && call.fillStyle !== fill());
    expect(cell).toBeGreaterThan(shaded);
  });

  it("should change the cache key when the zones change", () => {
    expect(footprintCacheKey(footprint({ rangeZones: [zone] }), 800, 400)).not.toBe(footprintCacheKey(footprint(), 800, 400));
  });
});

describe("drawBookmap range zones", () => {
  it("should draw a zone behind the heat and leave its fill out of the warmup band", () => {
    const base = bookmapModel();
    const { surface, calls } = fakeSurface(1100, 640);
    const zone: RangeZone = { startMs: 10_000, endMs: 90_000, lowTicks: 100, highTicks: 108 };

    drawBookmap(surface, { ...base, rangeZones: [zone] });

    const shaded = zoneFills(calls);
    expect(shaded).toHaveLength(1);
    const { plot } = base.frame;
    const watermarkX = plot.x + (plot.w * (base.historyWatermarkMs ?? 0)) / base.endMs;
    expect(shaded[0]?.args[0]).toBeCloseTo(watermarkX, 6);
    const band = firstIndex(calls, (call) => call.method === "fillRect" && call.fillStyle === withAlpha(color("warmup"), WARMUP_BAND_ALPHA));
    expect(band).toBeGreaterThan(-1);
    expect(calls.indexOf(shaded[0] as CanvasCall)).toBeLessThan(band);
  });

  it("should draw no zone when the model has none", () => {
    const { surface, calls } = fakeSurface(1100, 640);

    drawBookmap(surface, bookmapModel());

    expect(zoneFills(calls)).toHaveLength(0);
  });
});

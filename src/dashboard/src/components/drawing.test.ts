import { afterEach, describe, expect, it } from "vitest";

import type { Footprint } from "../api/schemas.ts";
import { withAlpha } from "../design/color.ts";
import { color } from "../design/tokens.ts";
import { aggregateCandles } from "../domain/candles.ts";
import { heatScale } from "../domain/heat.ts";
import { fromSnapshot, type VwapPoint } from "../domain/merge.ts";
import { fakeSurface } from "../test/fakeCanvas.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { mainChartDrawKey } from "./chartDrawKey.ts";
import { FOOTPRINT_GROUND, drawFootprint, footprintCacheKey, type FootprintModel } from "./drawFootprint.ts";
import { HISTORY_WITHOUT_TAPE, TAPE_STARTS_HERE } from "../domain/volumeDots.ts";
import { canvasTheme, colors } from "../theme.ts";
import { drawMainChart, type MainChartModel } from "./drawMainChart.ts";

const market = fromSnapshot(snapshotFixture(), 5, 0);
const candles = aggregateCandles(market.bars, market.developingBar, market.serverTimeMs);

function model(overrides: Partial<MainChartModel> = {}): MainChartModel {
  return {
    market,
    candles,
    startMs: market.serverTimeMs - 5 * 60_000,
    endMs: market.serverTimeMs + 10_000,
    lowTicks: 27000,
    highTicks: 27900,
    heatmap: true,
    heatColumns: market.heat,
    heatMode: "intensity",
    heatContrast: 1,
    heatScale: heatScale(market.heat),
    levelTouches: [],
    profile: null,
    emaIds: ["ema10"],
    vwap: true,
    overlay: true,
    signals: market.orderFlow.signals,
    isKindOn: () => true,
    ...overrides,
  };
}

describe("drawMainChart", () => {
  it("should leave a hover target for every signal in view when every kind is on", () => {
    const { surface } = fakeSurface();
    const inView = market.orderFlow.signals.filter((s) => s.timeMs >= market.serverTimeMs - 5 * 60_000 - 60_000);

    const geometry = drawMainChart(surface, model());

    expect(geometry.markers.filter((m) => inView.some((s) => m.title.endsWith(s.label))).length).toBe(inView.length);
  });

  it("should draw no signal marker when the signals are filtered out", () => {
    const { surface } = fakeSurface();

    const geometry = drawMainChart(surface, model({ signals: [] }));

    expect(geometry.markers.some((m) => m.title.startsWith("Spoof"))).toBe(false);
  });

  it("should label the overlay levels when the overlay is on", () => {
    const { surface, calls } = fakeSurface();

    drawMainChart(surface, model());

    expect(calls.some((c) => c.method === "fillText" && String(c.args[0]).startsWith("VWAP +1σ"))).toBe(true);
  });

  it("should label history without tape dots when the watermark is on screen", () => {
    const { surface, calls } = fakeSurface();
    const marked = {
      ...market,
      historyWatermarkMs: market.serverTimeMs - 60_000,
      prints: [
        { sourceTimeMs: market.serverTimeMs - 120_000, priceTicks: 27_400, quantity: 10, aggressor: "Bid", sequence: 1 },
        { sourceTimeMs: market.serverTimeMs - 10_000, priceTicks: 27_410, quantity: 10, aggressor: "Ask", sequence: 2 },
      ],
    };

    drawMainChart(surface, model({ market: marked, showVolumeDots: true }));

    expect(calls.some((call) => call.method === "fillText" && call.args[0] === HISTORY_WITHOUT_TAPE)).toBe(true);
    expect(calls.some((call) => call.method === "fillText" && call.args[0] === TAPE_STARTS_HERE)).toBe(true);
  });

  it("should draw a candle before the tape and skip one after it when candles are off", () => {
    const { surface, calls } = fakeSurface();
    const start = 1_700_000_000_000;
    const early = { t: start, d: 60_000, o: 100, h: 110, l: 90, c: 105, v: 1, bv: 1, sv: 0, developing: false };
    const late = { t: start + 300_000, d: 60_000, o: 100, h: 110, l: 90, c: 90, v: 1, bv: 0, sv: 1, developing: false };
    const marked = {
      ...market,
      serverTimeMs: start + 600_000,
      receivedAtMs: start + 600_000,
      historyWatermarkMs: null,
      printArrivedAtMs: start + 600_000,
      prints: [{ sourceTimeMs: start + 300_000, priceTicks: 100, quantity: 10, aggressor: "Bid" as const, sequence: 1 }],
    };

    drawMainChart(
      surface,
      model({
        market: marked,
        candles: [early, late],
        startMs: start,
        endMs: start + 600_000,
        lowTicks: 80,
        highTicks: 120,
        heatmap: false,
        showCandles: false,
        showVolumeDots: true,
      }),
    );

    const fills = calls.filter((call) => call.method === "fillRect").map((call) => call.fillStyle);
    expect(fills).toContain(colors.up);
    expect(fills).not.toContain(colors.down);
  });

  it("should still draw both candles when the candle layer and the dots are off", () => {
    const { surface, calls } = fakeSurface();
    const start = 1_700_000_000_000;
    const early = { t: start, d: 60_000, o: 100, h: 110, l: 90, c: 105, v: 1, bv: 1, sv: 0, developing: false };
    const late = { t: start + 300_000, d: 60_000, o: 100, h: 110, l: 90, c: 90, v: 1, bv: 0, sv: 1, developing: false };
    const marked = {
      ...market,
      serverTimeMs: start + 600_000,
      historyWatermarkMs: null,
      prints: [{ sourceTimeMs: start + 300_000, priceTicks: 100, quantity: 10, aggressor: "Bid" as const, sequence: 1 }],
    };

    drawMainChart(
      surface,
      model({
        market: marked,
        candles: [early, late],
        startMs: start,
        endMs: start + 600_000,
        lowTicks: 80,
        highTicks: 120,
        heatmap: false,
        showCandles: false,
        showVolumeDots: false,
      }),
    );

    const fills = calls.filter((call) => call.method === "fillRect").map((call) => call.fillStyle);
    expect(fills).toContain(colors.up);
    expect(fills).toContain(colors.down);
  });

  it("should hide VAH and VAL and emphasize nodes without changing the profile when the RIPS option is on", () => {
    const { surface, calls } = fakeSurface();
    const profile = {
      window: "session",
      bins: [[27_400, 10] as [number, number]],
      total: 10,
      poc: 27_400,
      vah: 27_420,
      val: 27_380,
      vaFraction: 0.7,
      partialSinceMs: null,
      missingRanges: [],
      approximateRanges: [],
      hvn: [27_400],
      lvn: [27_380],
    };
    const before = structuredClone(profile);

    drawMainChart(surface, model({ profile, hideValueArea: true, emphasizeNodes: true }));

    expect(profile).toEqual(before);
    expect(calls.some((call) => call.method === "fillText" && call.args[0] === "VAH")).toBe(false);
    expect(calls.some((call) => call.method === "fillText" && call.args[0] === "VAL")).toBe(false);
    expect(calls.some((call) => call.method === "fillText" && call.args[0] === "POC")).toBe(true);
    expect(calls.some((call) => call.method === "fillText" && call.args[0] === "HVN shelf")).toBe(true);
    expect(calls.some((call) => call.method === "fillText" && call.args[0] === "LVN slidy zone")).toBe(true);
  });

  it("should hatch partly unknown heat cells rather than leave them empty", () => {
    const { surface, calls } = fakeSurface();

    drawMainChart(surface, model());

    expect(calls.some((c) => c.method === "fill" && c.fillStyle === withAlpha(colors.muted, 0.35))).toBe(true);
  });
});

describe("mainChartDrawKey", () => {
  afterEach(() => canvasTheme.set("dark"));

  it("should change when the canvas theme changes, so a theme switch redraws the cached frame", () => {
    const base = model();

    expect(mainChartDrawKey(base, 800, 400, 1, 0, "light")).not.toBe(mainChartDrawKey(base, 800, 400, 1, 0, "dark"));
  });

  it("should key on the active canvas theme when no theme is passed", () => {
    const base = model();
    canvasTheme.set("light");

    expect(mainChartDrawKey(base, 800, 400, 1, 0)).toBe(mainChartDrawKey(base, 800, 400, 1, 0, "light"));
  });

  it("should stay the same when the live edge moves by less than a pixel", () => {
    const base = model({ startMs: 0, endMs: 3_600_000 });
    const nudged = model({ startMs: 100, endMs: 3_600_100 });

    expect(mainChartDrawKey(nudged, 800, 400)).toBe(mainChartDrawKey(base, 800, 400));
  });

  it("should change when a candle's close changes", () => {
    const base = model({ startMs: 0, endMs: 3_600_000 });
    const candle = base.candles[0];
    const changed = model({
      startMs: 0,
      endMs: 3_600_000,
      candles: candle ? [{ ...candle, c: candle.c + 1 }, ...base.candles.slice(1)] : base.candles,
    });

    expect(mainChartDrawKey(changed, 800, 400)).not.toBe(mainChartDrawKey(base, 800, 400));
  });

  it("should not treat candle volumes as equal when only their total matches", () => {
    const [first, second] = model().candles;
    if (!first || !second) return;

    const left = model({ candles: [{ ...first, v: 1 }, { ...second, v: 4 }] });
    const right = model({ candles: [{ ...first, v: 2 }, { ...second, v: 3 }] });

    expect(mainChartDrawKey(left, 800, 400)).not.toBe(mainChartDrawKey(right, 800, 400));
  });

  it("should change when a key level's price changes", () => {
    const level = { name: "VAL", priceTicks: 27_000, isHigh: false };
    const moved = { ...level, priceTicks: 27_001 };

    expect(flowKey({ keyLevels: [level] })).not.toBe(flowKey({ keyLevels: [moved] }));
  });

  it("should change when the footprint bar length changes", () => {
    expect(flowKey({ footprintSeconds: 60 })).not.toBe(flowKey({ footprintSeconds: 120 }));
  });

  it("should change when a stacked-imbalance zone changes", () => {
    const zone = { bias: "Bullish" as const, lowTicks: 27_000, highTicks: 27_004, levels: 3, averageRatio: 2 };
    const moved = { ...zone, highTicks: 27_008 };

    expect(flowKey({ zones: [zone] })).not.toBe(flowKey({ zones: [moved] }));
  });

  it("should change when an unfinished auction changes", () => {
    const auction = { priceTicks: 27_010, atHigh: true, barStartMs: 1, bidVolume: 4, askVolume: 1 };
    const moved = { ...auction, askVolume: 9 };

    expect(flowKey({ unfinishedAuctions: [auction] })).not.toBe(flowKey({ unfinishedAuctions: [moved] }));
  });

  it("should change when an iceberg's traded size changes", () => {
    const ice = {
      side: "Bid",
      priceTicks: 27_020,
      traded: 10,
      displayed: 2,
      peakDisplayed: 4,
      refills: 3,
      averageRefill: 2,
      hiddenEstimate: 8,
      confidence: 0.5,
      firstSeenMs: 1,
      lastFillMs: 2,
      active: true,
    };

    expect(flowKey({ icebergs: [ice] })).not.toBe(flowKey({ icebergs: [{ ...ice, traded: 40 }] }));
  });

  it("should change when a marker kind is toggled off", () => {
    expect(mainChartDrawKey(model({ isKindOn: () => false }), 800, 400)).not.toBe(mainChartDrawKey(model(), 800, 400));
  });

  it("should change when the profile value area changes and the POC stays put", () => {
    const profile = {
      window: "session",
      bins: [[27_000, 5] as [number, number]],
      total: 5,
      poc: 27_000,
      vah: 27_100,
      val: 26_900,
      vaFraction: 0.7,
      partialSinceMs: null,
      missingRanges: [],
      approximateRanges: [],
      hvn: [],
      lvn: [],
    };

    expect(mainChartDrawKey(model({ profile }), 800, 400)).not.toBe(mainChartDrawKey(model({ profile: { ...profile, vah: 27_200 } }), 800, 400));
  });

  it("should change when a level touch's count changes and the list length does not", () => {
    const touch = { name: "VAL", priceTicks: 27_000, isHigh: false, touches: 1, lastTouchMs: 5, isThirdTouch: false };

    expect(mainChartDrawKey(model({ levelTouches: [touch] }), 800, 400)).not.toBe(
      mainChartDrawKey(model({ levelTouches: [{ ...touch, touches: 2 }] }), 800, 400),
    );
  });

  it("should change when the device pixel ratio changes", () => {
    const chart = model();

    expect(mainChartDrawKey(chart, 800, 400, 1)).not.toBe(mainChartDrawKey(chart, 800, 400, 2));
  });

  it("should change when the canvas fonts finish loading", () => {
    const chart = model();

    expect(mainChartDrawKey(chart, 800, 400, 1, 0)).not.toBe(mainChartDrawKey(chart, 800, 400, 1, 1));
  });

  it("should change when a visible EMA point is rewritten and the length and last point stay the same", () => {
    const series = market.indicators.find((item) => item.id === "ema10");
    if (!series) throw new Error("the fixture needs ema10");
    const startMs = 100_000;
    const endMs = 200_000;
    const margin = series.tf * 1000;
    const points = [
      [startMs - margin - 5_000, 10],
      [startMs, 100],
      [endMs, 110],
    ];
    const rewritten = [
      [startMs - margin - 5_000, 10],
      [startMs, 140],
      [endMs, 110],
    ];
    const base = model({
      emaIds: ["ema10"],
      startMs,
      endMs,
      market: { ...market, indicators: [{ ...series, points }] },
    });
    const changed = model({
      emaIds: ["ema10"],
      startMs,
      endMs,
      market: { ...market, indicators: [{ ...series, points: rewritten }] },
    });

    expect(points.length).toBe(rewritten.length);
    expect(points.at(-1)).toEqual(rewritten.at(-1));
    expect(mainChartDrawKey(changed, 800, 400)).not.toBe(mainChartDrawKey(base, 800, 400));
  });

  it("should ignore an EMA point before the culling margin when the visible points match", () => {
    const series = market.indicators.find((item) => item.id === "ema10");
    if (!series) throw new Error("the fixture needs ema10");
    const startMs = 100_000;
    const endMs = 200_000;
    const margin = series.tf * 1000;
    const visible = [
      [startMs, 100],
      [endMs, 110],
    ];
    const base = model({
      emaIds: ["ema10"],
      startMs,
      endMs,
      market: { ...market, indicators: [{ ...series, points: [[startMs - margin - 5_000, 10], ...visible] }] },
    });
    const earlier = model({
      emaIds: ["ema10"],
      startMs,
      endMs,
      market: { ...market, indicators: [{ ...series, points: [[startMs - margin - 5_000, 80], ...visible] }] },
    });

    expect(mainChartDrawKey(earlier, 800, 400)).toBe(mainChartDrawKey(base, 800, 400));
  });

  it("should change when an EMA timeframe changes and its points do not", () => {
    const series = market.indicators.find((item) => item.id === "ema10");
    if (!series) throw new Error("the fixture needs ema10");
    const slower = { ...series, tf: series.tf + 60 };
    const base = model({ emaIds: ["ema10"], market: { ...market, indicators: [series] } });
    const changed = model({ emaIds: ["ema10"], market: { ...market, indicators: [slower] } });

    expect(series.tf).not.toBe(slower.tf);
    expect(mainChartDrawKey(changed, 800, 400)).not.toBe(mainChartDrawKey(base, 800, 400));
  });

  it("should change when an earlier VWAP point moves and the latest point does not", () => {
    const trail: readonly VwapPoint[] = [
      [1_000, 100, 1],
      [2_000, 110, 1],
      [3_000, 120, 2],
    ];
    const moved: readonly VwapPoint[] = [
      [1_000, 100, 1],
      [2_000, 140, 1],
      [3_000, 120, 2],
    ];
    const base = model({ vwap: true, startMs: 0, endMs: 10_000, market: { ...market, vwapTrail: trail } });
    const changed = model({ vwap: true, startMs: 0, endMs: 10_000, market: { ...market, vwapTrail: moved } });

    expect(trail[2]).toEqual(moved[2]);
    expect(mainChartDrawKey(changed, 800, 400)).not.toBe(mainChartDrawKey(base, 800, 400));
  });

  it("should ignore a VWAP point that ends before the window when the visible points match", () => {
    const visible: readonly VwapPoint[] = [
      [5_000, 110, 1],
      [8_000, 120, 2],
    ];
    const withHistory: readonly VwapPoint[] = [[1_000, 50, 9], ...visible];
    const base = model({ vwap: true, startMs: 4_000, endMs: 10_000, market: { ...market, vwapTrail: visible } });
    const earlier = model({ vwap: true, startMs: 4_000, endMs: 10_000, market: { ...market, vwapTrail: withHistory } });

    expect(mainChartDrawKey(earlier, 800, 400)).toBe(mainChartDrawKey(base, 800, 400));
  });

  it("should change when the heat column just before the window changes in flow mode", () => {
    const columns = [0, 1, 2].map((index) => ({ t: index * 60_000, d: 60_000, c: [27_000, 1, 2, 60_000] }));
    const changed = columns.map((column, index) => (index === 0 ? { ...column, c: [27_000, 8, 2, 60_000] } : column));
    const base = model({ heatmap: true, heatMode: "flow", startMs: 60_000, endMs: 180_000, heatColumns: columns });
    const next = model({ heatmap: true, heatMode: "flow", startMs: 60_000, endMs: 180_000, heatColumns: changed });

    expect(mainChartDrawKey(next, 800, 400)).not.toBe(mainChartDrawKey(base, 800, 400));
  });

  it("should ignore a heat column that ends before the one touching the window", () => {
    const columns = [0, 1, 2].map((index) => ({ t: index * 60_000, d: 60_000, c: [27_000, 1, 2, 60_000] }));
    const changed = columns.map((column, index) => (index === 0 ? { ...column, c: [27_000, 8, 2, 60_000] } : column));
    const base = model({ heatmap: true, heatMode: "flow", startMs: 120_000, endMs: 240_000, heatColumns: columns });
    const next = model({ heatmap: true, heatMode: "flow", startMs: 120_000, endMs: 240_000, heatColumns: changed });

    expect(mainChartDrawKey(next, 800, 400)).toBe(mainChartDrawKey(base, 800, 400));
  });

  it("should ignore the column before the window when the heatmap is intensity", () => {
    const columns = [0, 1].map((index) => ({ t: index * 60_000, d: 60_000, c: [27_000, 1, 2, 60_000] }));
    const changed = columns.map((column, index) => (index === 0 ? { ...column, c: [27_000, 8, 2, 60_000] } : column));
    const base = model({ heatmap: true, heatMode: "intensity", startMs: 60_000, endMs: 180_000, heatColumns: columns });
    const next = model({ heatmap: true, heatMode: "intensity", startMs: 60_000, endMs: 180_000, heatColumns: changed });

    expect(mainChartDrawKey(next, 800, 400)).toBe(mainChartDrawKey(base, 800, 400));
  });

  it("should change when an older heat cell changes and the column length does not", () => {
    const columns = [0, 1, 2, 3].map((index) => ({ t: index * 60_000, d: 60_000, c: [27_000, 1, 2, 60_000] }));
    const changed = columns.map((column, index) => (index === 0 ? { ...column, c: [27_000, 9, 2, 60_000] } : column));
    const base = model({ heatmap: true, startMs: 0, endMs: 240_000, heatColumns: columns });
    const next = model({ heatmap: true, startMs: 0, endMs: 240_000, heatColumns: changed });

    expect(columns[0]?.c.length).toBe(changed[0]?.c.length);
    expect(mainChartDrawKey(next, 800, 400)).not.toBe(mainChartDrawKey(base, 800, 400));
  });

  it("should change when the price decimals change and the ticks do not", () => {
    const changed = model({
      market: { ...market, instrument: { ...market.instrument, priceDecimals: market.instrument.priceDecimals + 1 } },
    });

    expect(mainChartDrawKey(changed, 800, 400)).not.toBe(mainChartDrawKey(model(), 800, 400));
  });

  it("should change when the tick size changes and the ticks do not", () => {
    const changed = model({
      market: { ...market, instrument: { ...market.instrument, tickSize: market.instrument.tickSize * 2 } },
    });

    expect(mainChartDrawKey(changed, 800, 400)).not.toBe(mainChartDrawKey(model(), 800, 400));
  });

  it("should ignore a heat cell when the heatmap is off", () => {
    const columns = [{ t: 0, d: 60_000, c: [27_000, 1, 2, 60_000] }];
    const changed = [{ t: 0, d: 60_000, c: [27_000, 9, 2, 60_000] }];
    const base = model({ heatmap: false, startMs: 0, endMs: 120_000, heatColumns: columns });
    const next = model({ heatmap: false, startMs: 0, endMs: 120_000, heatColumns: changed });

    expect(mainChartDrawKey(next, 800, 400)).toBe(mainChartDrawKey(base, 800, 400));
  });
});

function flowKey(orderFlow: Partial<MainChartModel["market"]["orderFlow"]>): string {
  return mainChartDrawKey(model({ market: { ...market, orderFlow: { ...market.orderFlow, ...orderFlow } } }), 800, 400);
}

describe("footprintCacheKey", () => {
  afterEach(() => canvasTheme.set("dark"));

  it("should change when the canvas theme changes, so cached cells are not reused in the other theme", () => {
    const footprint = footprintOf(bar());

    expect(footprintCacheKey(footprint, 1000, 300, 0, "light")).not.toBe(footprintCacheKey(footprint, 1000, 300, 0, "dark"));
  });

  it("should key on the active canvas theme when no theme is passed", () => {
    const footprint = footprintOf(bar());
    canvasTheme.set("light");

    expect(footprintCacheKey(footprint, 1000, 300, 0)).toBe(footprintCacheKey(footprint, 1000, 300, 0, "light"));
  });

  it("should ignore a sub-pixel window move and a change that is only the forming bar", () => {
    const bars = market.orderFlow.footprints;
    const footprint = {
      startMs: bars[0]?.t ?? 0,
      endMs: market.serverTimeMs,
      bars,
      developing: bars[0] ? { ...bars[0], t: market.serverTimeMs - 30_000, delta: 1, v: 4 } : null,
      spec: market.instrument,
    };
    const forming = footprint.developing ? { ...footprint.developing, delta: 8, v: 20 } : null;

    const slid = { ...footprint, startMs: footprint.startMs + 40, endMs: footprint.endMs + 40 };
    expect(footprintCacheKey(slid, 1000, 300)).toBe(footprintCacheKey(footprint, 1000, 300));
    expect(footprintCacheKey({ ...footprint, developing: forming }, 1000, 300)).toBe(footprintCacheKey(footprint, 1000, 300));
  });

  it("should change when a closed bar's delta changes", () => {
    const bars = market.orderFlow.footprints;
    const footprint = { startMs: bars[0]?.t ?? 0, endMs: market.serverTimeMs, bars, developing: null, spec: market.instrument };
    const changed = bars.map((bar, index) => (index === 0 ? { ...bar, delta: bar.delta + 1 } : bar));

    expect(footprintCacheKey({ ...footprint, bars: changed }, 1000, 300)).not.toBe(footprintCacheKey(footprint, 1000, 300));
  });

  it("should change when an approximate range is added and the bars stay put", () => {
    const bars = market.orderFlow.footprints;
    const footprint = {
      startMs: bars[0]?.t ?? 0,
      endMs: market.serverTimeMs,
      bars,
      developing: null,
      spec: market.instrument,
      missingRanges: [] as readonly (readonly (number | null)[])[],
      approximateRanges: [] as readonly (readonly (number | null)[])[],
    };

    expect(footprintCacheKey({ ...footprint, approximateRanges: [[footprint.startMs, footprint.endMs]] }, 1000, 300)).not.toBe(
      footprintCacheKey(footprint, 1000, 300),
    );
  });

  it("should change when two closed bars differ and their summed fields match", () => {
    const left = bar({ delta: 5, v: 10 });
    const right = bar({ delta: 6, v: 9 });

    expect(summedFields(left)).toBe(summedFields(right));
    expect(footprintCacheKey(footprintOf(left), 1000, 300)).not.toBe(footprintCacheKey(footprintOf(right), 1000, 300));
  });

  it("should change when a closed cell changes and the bar totals do not", () => {
    const left = bar({ c: [100, 4, 6, 1] });
    const right = bar({ c: [100, 5, 5, 1] });

    expect(left.delta).toBe(right.delta);
    expect(left.v).toBe(right.v);
    expect(footprintCacheKey(footprintOf(left), 1000, 300)).not.toBe(footprintCacheKey(footprintOf(right), 1000, 300));
  });

  it("should change when a closed bar's duration changes and its totals do not", () => {
    const left = footprintOf(bar({ d: 60_000 }));
    const right = footprintOf(bar({ d: 30_000 }));

    expect(footprintCacheKey(left, 1000, 300)).not.toBe(footprintCacheKey(right, 1000, 300));
  });

  it("should change when the canvas fonts finish loading", () => {
    const closed = bar();

    expect(footprintCacheKey(footprintOf(closed), 1000, 300, 0)).not.toBe(footprintCacheKey(footprintOf(closed), 1000, 300, 1));
  });

  it("should change when the price decimals change and the cells do not", () => {
    const footprint = footprintOf(bar());
    const finer = { ...footprint, spec: { ...footprint.spec, priceDecimals: footprint.spec.priceDecimals + 1 } };

    expect(footprintCacheKey(finer, 1000, 300)).not.toBe(footprintCacheKey(footprint, 1000, 300));
  });
});

function bar(overrides: Partial<Footprint> = {}): Footprint {
  return {
    t: 1_000,
    d: 60_000,
    o: 10,
    h: 12,
    l: 9,
    cl: 11,
    v: 10,
    delta: 1,
    maxDelta: 1,
    minDelta: 0,
    c: [100, 4, 6, 0],
    missing: false,
    ...overrides,
  };
}

function footprintOf(closed: Footprint): FootprintModel {
  return { startMs: 0, endMs: 120_000, bars: [closed], developing: null, spec: market.instrument };
}

/** The old cache key added these fields, so equal sums hid a different bar. */
function summedFields(closed: Footprint): number {
  return closed.t + closed.delta + closed.v + closed.c.length + (closed.missing ? 1 : 0);
}

describe("drawFootprint", () => {
  it("should mark a repaired minute as approximate and an unrepaired hole as missing", () => {
    const { surface, calls } = fakeSurface(800, 240);
    const bar = market.orderFlow.footprints[0];
    expect(bar).toBeDefined();
    if (!bar) return;
    const missingBar = { ...bar, t: bar.t + 60_000 };

    drawFootprint(surface, {
      startMs: bar.t - 1_000,
      endMs: missingBar.t + bar.d + 1_000,
      bars: [bar, missingBar],
      developing: null,
      spec: market.instrument,
      missingRanges: [[missingBar.t, missingBar.t + bar.d]],
      approximateRanges: [[bar.t, bar.t + bar.d]],
    });

    const texts = calls.filter((call) => call.method === "fillText").map((call) => String(call.args[0]));
    expect(texts.some((text) => text.startsWith("≈"))).toBe(true);
    expect(texts.some((text) => text.startsWith("~"))).toBe(true);
  });

  it("should paint the pane in FOOTPRINT_GROUND, the ground the cell text is picked against, in both themes", () => {
    // One source for the ground, so the contrast test cannot pass against a ground the pane does not paint.
    const ground = () => {
      const { surface, calls } = fakeSurface(800, 240);
      drawFootprint(surface, footprintOf(bar({ t: 0 })));
      return calls.find((call) => call.method === "fillRect")?.fillStyle;
    };

    const dark = ground();
    canvasTheme.set("light");
    let light: unknown;
    try {
      light = ground();
    } finally {
      canvasTheme.set("dark");
    }

    expect([dark, light]).toEqual([color(FOOTPRINT_GROUND), color(FOOTPRINT_GROUND, "light")]);
  });

  it("should print a split cell's volume in the most readable text over its own shade when a column is split", () => {
    // Grey down at 85% left on-surface-variant at 1.9:1 in Terminal; the text now reads its cell.
    const closed = bar({ t: 0, c: [102, 1, 50, 1, 101, 40, 2, -1, 100, 3, 5, 0] });
    const textColour = (calls: readonly { method: string; args: readonly unknown[]; fillStyle?: unknown }[], text: string) =>
      calls.find((call) => call.method === "fillText" && call.args[0] === text)?.fillStyle;
    const paint = () => {
      const { surface, calls } = fakeSurface(800, 240);
      drawFootprint(surface, footprintOf(closed));
      return calls;
    };

    const dark = paint();
    canvasTheme.set("light");
    let light: ReturnType<typeof paint>;
    try {
      light = paint();
    } finally {
      canvasTheme.set("dark");
    }

    expect(["40", "50", "3", "5"].map((text) => textColour(dark, text))).toEqual([
      color("surface-lowest"),
      color("surface-lowest"),
      color("on-surface-variant"),
      color("on-surface-variant"),
    ]);
    expect(["40", "50", "3"].map((text) => textColour(light, text))).toEqual([
      color("surface-lowest", "light"),
      color("surface-lowest", "light"),
      color("on-surface-variant", "light"),
    ]);
  });

  it("should print the delta of each bar in view when the bars are wide enough", () => {
    const { surface, calls } = fakeSurface(1200, 300);
    const bars = market.orderFlow.footprints;

    drawFootprint(surface, { startMs: (bars[0]?.t ?? 0) - 60_000, endMs: market.serverTimeMs, bars, developing: null, spec: market.instrument });

    const texts = calls.filter((c) => c.method === "fillText").map((c) => String(c.args[0]));
    expect(bars.every((b) => texts.includes(b.delta > 0 ? `+${b.delta.toLocaleString("en-US")}` : String(b.delta)))).toBe(true);
  });
});

import { afterEach, describe, expect, it } from "vitest";

import { contrastRatio } from "../design/color.ts";
import { aggregateCandles } from "../domain/candles.ts";
import { heatScale } from "../domain/heat.ts";
import { LINE_TAG_HEIGHT } from "../domain/lineTags.ts";
import { fromSnapshot, type IndicatorSeries } from "../domain/merge.ts";
import { fakeSurface, type CanvasCall } from "../test/fakeCanvas.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { AXIS_WIDTH, canvasTheme, colors, emaColors } from "../theme.ts";
import { mainChartDrawKey } from "./chartDrawKey.ts";
import { drawLineTags, lineTagFill } from "./drawLineTags.ts";
import { drawMainChart, type MainChartModel } from "./drawMainChart.ts";

// reference: REQUIREMENTS.md FR-77, FR-17, NFR-8 (ARCHITECTURE.md D-63)

afterEach(() => canvasTheme.set("dark"));

const base = fromSnapshot(snapshotFixture(), 5, 0);
const candles = aggregateCandles(base.bars, base.developingBar, base.serverTimeMs);
const last = candles.at(-1)?.c ?? 0;
const WIDTH = 800;
const PLOT_RIGHT = WIDTH - AXIS_WIDTH;

function ema(id: string, value: number, ready = true): IndicatorSeries {
  return { id, label: id, kind: "ema", tf: 60, warmup: 10, seen: 20, ready, points: [[base.serverTimeMs - 60_000, value]], dev: [value] };
}

function chart(overrides: Partial<MainChartModel> = {}, market = base): MainChartModel {
  return {
    market,
    candles,
    startMs: market.serverTimeMs - 5 * 60_000,
    endMs: market.serverTimeMs + 10_000,
    lowTicks: last - 40,
    highTicks: last + 40,
    heatmap: false,
    heatColumns: [],
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

const withLines = (indicators: IndicatorSeries[], vwap = { vwap: last + 10, stdDev: 4, volume: 1, partial: false }) => ({ ...base, indicators, vwap });
const texts = (calls: readonly CanvasCall[]) => calls.filter((c) => c.method === "fillText").map((c) => c.args[0]);
// A tag is its outline in the line's colour at the axis edge; its top is the box's top.
const tagBoxes = (calls: readonly CanvasCall[], hue: string) => calls.filter((c) => c.method === "strokeRect" && c.strokeStyle === hue && Math.floor(Number(c.args[0])) === PLOT_RIGHT + 2);

describe("drawMainChart line tags", () => {
  it("should name each visible EMA on the price axis in the line's own colour", () => {
    const { surface, calls } = fakeSurface(WIDTH, 400);
    const market = withLines([ema("ema13", last + 5), ema("ema200", last - 15)]);

    drawMainChart(surface, chart({ emaIds: ["ema13", "ema200"] }, market));

    expect(texts(calls)).toEqual(expect.arrayContaining(["EMA13", "EMA200"]));
    expect(tagBoxes(calls, emaColors.ema13 ?? "")).toHaveLength(1);
    expect(tagBoxes(calls, emaColors.ema200 ?? "")).toHaveLength(1);
  });

  it("should name the VWAP and its four bands in the VWAP colour", () => {
    const { surface, calls } = fakeSurface(WIDTH, 400);

    drawMainChart(surface, chart({ vwap: true }, withLines([])));

    // The in-plot "VWAP" label is drawn at x 4 or so; the axis tags start at the axis edge.
    const axisWords = calls.filter((c) => c.method === "fillText" && Number(c.args[1]) > PLOT_RIGHT).map((c) => c.args[0]);
    expect(axisWords).toEqual(expect.arrayContaining(["VWAP", "VWAP+1σ", "VWAP-1σ", "VWAP+2σ", "VWAP-2σ"]));
    expect(tagBoxes(calls, colors.vwap)).toHaveLength(5);
  });

  it("should say a line is warming up in its tag", () => {
    const { surface, calls } = fakeSurface(WIDTH, 400);

    drawMainChart(surface, chart({ emaIds: ["ema48"] }, withLines([ema("ema48", last, false)])));

    expect(texts(calls)).toContain("EMA48 warm");
    expect(texts(calls)).not.toContain("EMA48");
  });

  it("should draw no tag for a layer that is off", () => {
    const { surface, calls } = fakeSurface(WIDTH, 400);

    drawMainChart(surface, chart({ emaIds: [], vwap: false }, withLines([ema("ema13", last)])));

    expect(texts(calls)).not.toContain("EMA13");
    expect(texts(calls)).not.toContain("VWAP");
  });

  it("should draw no tag at all when the line tags are switched off", () => {
    const { surface, calls } = fakeSurface(WIDTH, 400);

    drawMainChart(surface, chart({ emaIds: ["ema13"], vwap: true, lineTags: false }, withLines([ema("ema13", last)])));

    expect(texts(calls)).not.toContain("EMA13");
    expect(texts(calls).filter((t) => typeof t === "string" && t.startsWith("VWAP+"))).toEqual([]);
  });

  it("should skip a line whose end price is outside the visible range", () => {
    const { surface, calls } = fakeSurface(WIDTH, 400);

    drawMainChart(surface, chart({ emaIds: ["ema10"] }, withLines([ema("ema10", last + 500)])));

    expect(texts(calls)).not.toContain("EMA10");
  });

  it("should stack tags that share a price, and keep them off the last-price tag", () => {
    const { surface, calls } = fakeSurface(WIDTH, 400);
    const market = withLines([ema("ema10", last), ema("ema13", last), ema("ema24", last)]);

    drawMainChart(surface, chart({ emaIds: ["ema10", "ema13", "ema24"] }, market));

    const ys = ["ema10", "ema13", "ema24"].flatMap((id) => tagBoxes(calls, emaColors[id] ?? "").map((c) => Number(c.args[1]) - 0.5 + LINE_TAG_HEIGHT / 2));
    const lastTag = calls.find((c) => c.method === "fillRect" && c.fillStyle === colors.priceTag && c.args[0] === PLOT_RIGHT + 2);
    const all = [...ys, Number(lastTag?.args[1]) + LINE_TAG_HEIGHT / 2].sort((a, b) => a - b);
    expect(all).toHaveLength(4);
    for (let i = 1; i < all.length; i++) expect((all[i] ?? 0) - (all[i - 1] ?? 0)).toBeGreaterThanOrEqual(LINE_TAG_HEIGHT);
  });

  it("should tag an EMA at the value its line has at the window's right edge when panned back", () => {
    const { surface, calls } = fakeSurface(WIDTH, 400);
    const edge = base.serverTimeMs - 30 * 60_000;
    const market = withLines([{ ...ema("ema13", last + 30), points: [[edge - 90_000, last - 20], [edge - 30_000, last], [edge + 30_000, last + 20]], dev: null }]);
    const model = chart({ emaIds: ["ema13"], startMs: edge - 5 * 60_000, endMs: edge }, market);

    const geometry = drawMainChart(surface, model);

    const [box] = tagBoxes(calls, emaColors.ema13 ?? "");
    expect((Number(box?.args[1]) - 0.5 + LINE_TAG_HEIGHT / 2)).toBeCloseTo(geometry.price.toPx(last + 10), 0);
  });

  it("should tag a 15-minute EMA whose newest closed point is older than a 10-minute window, where its line is drawn", () => {
    const { surface, calls } = fakeSurface(WIDTH, 400);
    const now = base.serverTimeMs;
    const series: IndicatorSeries = { ...ema("ema48", last), tf: 900, points: [[now - 720_000, last - 10]], dev: [last + 12] };
    const model = chart({ emaIds: ["ema48"], startMs: now - 600_000, endMs: now + 30_000 }, withLines([series]));

    const geometry = drawMainChart(surface, model);

    const drawn = calls.filter((c) => c.method === "lineTo" && c.strokeStyle === emaColors.ema48);
    expect(drawn).not.toHaveLength(0);
    const [box] = tagBoxes(calls, emaColors.ema48 ?? "");
    expect(box).toBeDefined();
    expect(Number(box?.args[1]) - 0.5 + LINE_TAG_HEIGHT / 2).toBeCloseTo(geometry.price.toPx(last + 12), 0);
  });

  it("should draw no EMA tag when the window holds none of its points", () => {
    const { surface, calls } = fakeSurface(WIDTH, 400);
    const edge = base.serverTimeMs - 30 * 60_000;
    const market = withLines([ema("ema13", last)]);

    drawMainChart(surface, chart({ emaIds: ["ema13"], startMs: edge - 5 * 60_000, endMs: edge }, market));

    expect(texts(calls)).not.toContain("EMA13");
  });

  it.each([["bestBid", colors.bid], ["bestAsk", colors.ask]] as const)("should keep a tag whose line is at the %s clear of the best-price tag", (side, fillStyle) => {
    const { surface, calls } = fakeSurface(WIDTH, 400);
    const at = last + 10; // clear of the last-price tag, so only the quote tag can displace the line tag
    const market = { ...withLines([ema("ema13", at)]), liquidity: { ...base.liquidity, bestBid: at - 20, bestAsk: at + 20, [side]: at } };

    drawMainChart(surface, chart({ emaIds: ["ema13"] }, market));

    const quote = calls.find((c) => c.method === "fillRect" && c.fillStyle === fillStyle && c.args[0] === PLOT_RIGHT + 2);
    const [box] = tagBoxes(calls, emaColors.ema13 ?? "");
    expect(quote).toBeDefined();
    expect(Math.abs(Number(box?.args[1]) - 0.5 - Number(quote?.args[1]))).toBeGreaterThanOrEqual(LINE_TAG_HEIGHT);
  });

  it("should change the draw key when the tags are switched", () => {
    expect(mainChartDrawKey(chart({ lineTags: false }), 800, 400)).not.toBe(mainChartDrawKey(chart(), 800, 400));
  });
});

describe("line tag contrast", () => {
  const keys = ["vwap", "ema10", "ema13", "ema24", "ema48", "ema200"];

  it.each(["dark", "light"] as const)("should hold the line floor for the colour and the text floor for the words in the %s theme", (theme) => {
    canvasTheme.set(theme);
    for (const key of keys) {
      expect(contrastRatio(lineTagFill(key), colors.chip), `${key} line in ${theme}`).toBeGreaterThanOrEqual(3);
    }
    expect(contrastRatio(colors.strong, colors.chip)).toBeGreaterThanOrEqual(4.5);
  });

  it("should draw the words in the strong ink on the axis chip", () => {
    const { surface, calls } = fakeSurface(WIDTH, 400);

    drawMainChart(surface, chart({ emaIds: ["ema13"] }, withLines([ema("ema13", last + 5)])));

    const words = calls.find((c) => c.method === "fillText" && c.args[0] === "EMA13");
    expect(words?.fillStyle).toBe(colors.strong);
    expect(calls.some((c) => c.method === "fillRect" && c.fillStyle === colors.chip && Math.floor(Number(c.args[0])) === PLOT_RIGHT + 2)).toBe(true);
  });
});

describe("drawLineTags", () => {
  it("should draw nothing without specs", () => {
    const { surface, calls } = fakeSurface(WIDTH, 400);

    drawLineTags(surface.ctx, chart({ lineTags: false }, withLines([ema("ema13", last)])), { toPx: () => 100 } as never, PLOT_RIGHT, WIDTH, 380, []);

    expect(calls.filter((c) => c.method === "fillText")).toEqual([]);
  });
});

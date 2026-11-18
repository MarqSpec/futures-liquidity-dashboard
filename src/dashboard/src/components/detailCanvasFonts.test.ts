import { describe, expect, it } from "vitest";

import { formatTicks } from "../domain/format.ts";
import { falling, market, model, profile, start } from "../test/detailCanvasFixtures.ts";
import { fakeSurface, type CanvasCall } from "../test/fakeCanvas.ts";
import { fonts } from "../theme.ts";
import { drawFootprint } from "./drawFootprint.ts";
import { drawMainChart, drawMainCrosshair } from "./drawMainChart.ts";
import { drawProfile } from "./drawProfile.ts";
import { drawSeriesPane } from "./drawSeriesPane.ts";

// Canvas text is IBM Plex Mono at the data-xs and data-sm sizes.

const allowed = new Set<unknown>(Object.values(fonts));

function textFonts(calls: readonly CanvasCall[]): unknown[] {
  return calls.filter((call) => call.method === "fillText").map((call) => call.font);
}

describe("Detail canvas text", () => {
  it("should write every main chart label in a data-xs or data-sm face when the chart is busy", () => {
    const { surface, calls } = fakeSurface();
    const levelTouches = [{ name: "PDH", priceTicks: 110, isHigh: true, touches: 3, isThirdTouch: true }];

    const geometry = drawMainChart(surface, model({ profile, emphasizeNodes: true, levelTouches, signals: market.orderFlow.signals }));
    const layer = fakeSurface();
    drawMainCrosshair(layer.surface, geometry, market.instrument, start + 120_000, 100);

    const written = [...textFonts(calls), ...textFonts(layer.calls)];
    expect(written.length).toBeGreaterThan(10);
    expect(written.filter((font) => !allowed.has(font))).toEqual([]);
  });

  it("should write the axis tags in data-xs and the last price at 600 when the quote and close are in view", () => {
    const { surface, calls } = fakeSurface();
    // The axis may print the same price as a grid tick; the tags are written last.
    const fontOf = (ticks: number) => calls.filter((call) => call.method === "fillText" && call.args[0] === formatTicks(ticks, market.instrument)).at(-1)?.font;

    drawMainChart(surface, model({ vwap: false }));

    expect(fontOf(falling.c)).toBe(fonts.tag);
    expect(fontOf(95)).toBe(fonts.xs);
    expect(fontOf(96)).toBe(fonts.xs);
  });

  it("should write the pane's axis and title in the data faces when an indicator pane is drawn", () => {
    const { surface, calls } = fakeSurface();

    drawSeriesPane(surface, { startMs: start, endMs: start + 600_000, title: "RSI", subtitle: "54", dimmed: false, lines: [], range: { low: 0, high: 100 }, guides: [30, 70], format: String });

    expect(textFonts(calls).length).toBeGreaterThan(1);
    expect(textFonts(calls).filter((font) => !allowed.has(font))).toEqual([]);
  });

  it("should write footprint cells data-sm when rows are tall and data-xs when they are short", () => {
    // One closed bar with cells at 100–102 on a seven-tick window: a 264px plot gives 37px rows, a 77px plot 11px rows.
    const closed = { t: 0, d: 60_000, v: 30, delta: 1, maxDelta: 1, minDelta: 0, c: [100, 4, 6, 0, 101, 7, 8, 0, 102, 1, 2, 0] };
    const window = { startMs: 0, endMs: 120_000, lowTicks: 98, highTicks: 104, bars: [closed], developing: null, spec: market.instrument };
    const strip = 20 + 16;
    const tall = fakeSurface(1200, 264 + strip);
    const short = fakeSurface(1200, 77 + strip);

    drawFootprint(tall.surface, window);
    drawFootprint(short.surface, window);

    const cellFonts = (calls: typeof tall.calls) =>
      calls.filter((call) => call.method === "fillText" && ["4", "6", "7", "8", "1", "2"].includes(String(call.args[0]))).map((call) => call.font);
    expect(textFonts(tall.calls).filter((font) => !allowed.has(font))).toEqual([]);
    expect(textFonts(short.calls).filter((font) => !allowed.has(font))).toEqual([]);
    expect(cellFonts(tall.calls)).toHaveLength(6);
    expect(new Set(cellFonts(tall.calls))).toEqual(new Set([fonts.sm]));
    expect(cellFonts(short.calls)).toHaveLength(6);
    expect(new Set(cellFonts(short.calls))).toEqual(new Set([fonts.xs]));
  });

  it("should write the profile's labels in the data faces when it draws", () => {
    const full = fakeSurface(240, 300);
    const empty = fakeSurface(240, 300);

    drawProfile(full.surface, profile, market.instrument, 100);
    drawProfile(empty.surface, { ...profile, bins: [] }, market.instrument, null);

    const written = [...textFonts(full.calls), ...textFonts(empty.calls)];
    expect(written.length).toBeGreaterThan(3);
    expect(written.filter((font) => !allowed.has(font))).toEqual([]);
  });
});

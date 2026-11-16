import { describe, expect, it } from "vitest";

import { decodeFootprint, footprintRows } from "../domain/footprint.ts";
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
    const bars = market.orderFlow.footprints;
    const window = { startMs: (bars[0]?.t ?? 0) - 60_000, endMs: market.serverTimeMs, bars, developing: null, spec: market.instrument };
    const rows = footprintRows(bars.map((bar) => decodeFootprint(bar))).length;
    // 16px title band and 16px delta strip around the rows: 18px rows (the cap) and 11px rows.
    const tall = fakeSurface(1200, 2000);
    const short = fakeSurface(1200, 32 + rows * 11);

    drawFootprint(tall.surface, window);
    drawFootprint(short.surface, window);

    expect(textFonts(tall.calls).filter((font) => !allowed.has(font))).toEqual([]);
    expect(textFonts(short.calls).filter((font) => !allowed.has(font))).toEqual([]);
    // The pane's title is data-sm at any height; tall rows add the cells.
    expect(textFonts(tall.calls).filter((font) => font === fonts.sm).length).toBeGreaterThan(1);
    expect(textFonts(short.calls).filter((font) => font === fonts.sm)).toHaveLength(1);
    expect(textFonts(short.calls).filter((font) => font === fonts.xs).length).toBeGreaterThan(bars.length);
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

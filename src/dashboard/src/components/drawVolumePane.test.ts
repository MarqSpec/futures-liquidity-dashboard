import { describe, expect, it } from "vitest";

import type { Candle } from "../domain/candles.ts";
import { fakeSurface, type CanvasCall } from "../test/fakeCanvas.ts";
import { AXIS_WIDTH, colors } from "../theme.ts";
import { drawVolumePane, volumePaneBars } from "./drawVolumePane.ts";

// The indicator dock's Volume tab, on Detail and Order Flow: each chart bar's traded volume on the chart's time axis, warmup bars grey (REQUIREMENTS.md FR-61).

function candle(t: number, v: number, bv: number, sv: number): Candle {
  return { t, d: 60_000, o: 100, h: 101, l: 99, c: 100, v, bv, sv, developing: false };
}

/**
 * Filled rectangles whose left edge is in [from, to), as [fill, x, y, w, h]. The ground spans the pane and the title
 * chip ends above the bars' top (y 14), so neither counts.
 */
function barFills(calls: readonly CanvasCall[], from: number, to: number): [unknown, number, number, number, number][] {
  return calls
    .filter((call) => call.method === "fillRect")
    .map((call): [unknown, number, number, number, number] => [call.fillStyle, ...(call.args as [number, number, number, number])])
    .filter(([, x, y, w, h]) => x >= from && x < to && w < 400 && y + h > 18);
}

describe("volumePaneBars", () => {
  it("should mark a bar that starts at or before the watermark as warmup, the same as Order Flow's volume strip", () => {
    const bars = volumePaneBars([candle(0, 10, 0, 0), candle(60_000, 10, 6, 4), candle(120_000, 8, 5, 3)], 60_000);

    expect(bars.map((bar) => bar.warmup)).toEqual([true, true, false]);
    expect(volumePaneBars([candle(0, 10, 6, 4)], null).map((bar) => bar.warmup)).toEqual([false]);
  });

  it("should keep each bar's traded volume, buy and sell when it reads the chart's bars", () => {
    const [bar] = volumePaneBars([candle(0, 12, 6, 4)], null);

    expect(bar).toMatchObject({ t: 0, d: 60_000, volume: 12, buy: 6, sell: 4, warmup: false });
  });
});

describe("drawVolumePane", () => {
  const model = (bars: readonly Candle[], watermark: number | null) => ({
    startMs: 0,
    endMs: 240_000,
    bars: volumePaneBars(bars, watermark),
  });

  it("should paint a warmup bar in the warmup colour only and a live bar in the buy and sell colours", () => {
    const { surface, calls } = fakeSurface(800 + 60, 200);
    // The warmup bar carries a side, as a print before the watermark can: it is still drawn with none.
    const geometry = drawVolumePane(surface, model([candle(0, 10, 6, 4), candle(60_000, 10, 6, 4)], 30_000));
    const right = geometry.time.toPx(60_000);

    const warm = barFills(calls, 0, right - 1).map(([fill]) => fill);
    const live = barFills(calls, right - 1, geometry.time.toPx(120_000)).map(([fill]) => fill);

    expect(warm).toEqual([colors.warmup]);
    expect(live).toContain(colors.aggressorBuy);
    expect(live).toContain(colors.aggressorSell);
    expect(live).not.toContain(colors.warmup);
  });

  it("should draw each bar's height from its traded volume when two bars differ", () => {
    const { surface, calls } = fakeSurface(860, 200);
    const geometry = drawVolumePane(surface, model([candle(0, 10, 10, 0), candle(60_000, 5, 5, 0)], null));
    const height = (from: number, to: number) => barFills(calls, from, to).reduce((sum, [, , , , h]) => sum + h, 0);

    const tall = height(0, geometry.time.toPx(60_000) - 1);
    const short = height(geometry.time.toPx(60_000) - 1, geometry.time.toPx(120_000));

    expect(short).toBeGreaterThan(0);
    expect(tall / short).toBeCloseTo(2, 5);
  });

  it("should show unsided volume of a live bar in the warmup colour rather than as buying or selling", () => {
    const { surface, calls } = fakeSurface(860, 200);
    const geometry = drawVolumePane(surface, model([candle(0, 10, 4, 2)], null));

    const fills = barFills(calls, 0, geometry.time.toPx(60_000));
    const share = (fill: string) => fills.filter(([f]) => f === fill).reduce((sum, [, , , , h]) => sum + h, 0);
    const total = fills.reduce((sum, [, , , , h]) => sum + h, 0);

    expect(share(colors.aggressorBuy) / total).toBeCloseTo(0.4, 5);
    expect(share(colors.aggressorSell) / total).toBeCloseTo(0.2, 5);
    expect(share(colors.warmup) / total).toBeCloseTo(0.4, 5);
  });

  it("should leave out a bar outside the window when the chart has panned away from it", () => {
    const { surface, calls } = fakeSurface(860, 200);
    drawVolumePane(surface, { startMs: 120_000, endMs: 240_000, bars: volumePaneBars([candle(0, 10, 6, 4)], null) });

    expect(calls.some((call) => call.method === "fillRect" && call.fillStyle === colors.aggressorBuy)).toBe(false);
  });

  it("should run the time axis across the pane less the axis width the caller gives, so Order Flow's plot and the bars line up", () => {
    const wide = drawVolumePane(fakeSurface(800, 200).surface, { ...model([candle(0, 10, 6, 4)], null), axisWidth: 240 });
    const plain = drawVolumePane(fakeSurface(800, 200).surface, model([candle(0, 10, 6, 4)], null));

    expect(wide.plotWidth).toBe(560);
    expect(wide.time.toPx(240_000)).toBe(560);
    expect(plain.plotWidth).toBe(800 - AXIS_WIDTH);
  });
});

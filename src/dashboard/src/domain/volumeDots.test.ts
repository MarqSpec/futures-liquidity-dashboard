import { describe, expect, it } from "vitest";

import { aggressorColor, candleIsPriceMark, tapeBoundaryMs, tradeFlashAlpha, volumeDots, type TapePrint } from "./volumeDots.ts";

function print(sourceTimeMs: number, priceTicks: number, quantity: number, aggressor: "Bid" | "Ask", sequence: number): TapePrint {
  return { sourceTimeMs, priceTicks, quantity, aggressor, sequence };
}

const frame = {
  startMs: 1_000,
  endMs: 1_000 + 3_600_000,
  plotWidthPx: 100,
  priceSpanTicks: 40,
  plotHeightPx: 40,
  minQuantity: 2,
};

describe("volumeDots", () => {
  it("should omit a print at the watermark and keep one after it when history has no tape", () => {
    const dots = volumeDots({
      ...frame,
      historyWatermarkMs: 2_000,
      prints: [print(2_000, 10, 5, "Bid", 1), print(2_001, 12, 5, "Ask", 2)],
    });

    expect(dots).toHaveLength(1);
    expect(dots[0]?.aggressor).toBe("Ask");
    expect(dots[0]?.priceTicks).toBe(12);
    // Up blue and down grey.
    expect(aggressorColor("Bid")).toBe("#6f84ff");
    expect(aggressorColor("Ask")).toBe("#b0b0b0");
  });

  it("should drop a print below the minimum and keep it out of the radius when the filter is on", () => {
    const dots = volumeDots({
      ...frame,
      historyWatermarkMs: null,
      minQuantity: 5,
      prints: [print(3_000, 10, 4, "Bid", 1), print(3_000, 10, 6, "Bid", 2)],
    });

    expect(dots).toHaveLength(1);
    expect(dots[0]?.quantity).toBe(6);
  });

  it("should center a bucket on the volume-weighted price when several prints share a pixel", () => {
    const dots = volumeDots({
      ...frame,
      historyWatermarkMs: null,
      minQuantity: 1,
      plotHeightPx: 1,
      prints: [print(5_000, 10, 1, "Bid", 1), print(5_000, 20, 3, "Bid", 2)],
    });

    expect(dots).toHaveLength(1);
    expect(dots[0]?.priceTicks).toBe(17.5);
    expect(dots[0]?.quantity).toBe(4);
  });

  it("should split a wide window into fewer time buckets than a zoomed window when the same prints are redrawn", () => {
    const prints = [print(10_000, 10, 5, "Bid", 1), print(10_000 + 50_000, 10, 5, "Bid", 2)];
    const wide = volumeDots({ ...frame, historyWatermarkMs: null, prints, endMs: frame.startMs + 3_600_000, plotWidthPx: 10 });
    const zoomed = volumeDots({ ...frame, historyWatermarkMs: null, prints, endMs: frame.startMs + 60_000, plotWidthPx: 600 });

    expect(wide).toHaveLength(1);
    expect(zoomed).toHaveLength(2);
  });

  it("should keep the same time bins when the window pans and both prints stay inside", () => {
    const prints = [print(1_000, 10, 5, "Bid", 1), print(2_900, 10, 5, "Bid", 2)];
    const left = volumeDots({ ...frame, historyWatermarkMs: null, prints, startMs: 0, endMs: 60_000, plotWidthPx: 600 });
    const right = volumeDots({ ...frame, historyWatermarkMs: null, prints, startMs: 1_000, endMs: 61_000, plotWidthPx: 600 });

    expect(left).toHaveLength(2);
    expect(right.map((dot) => dot.timeMs)).toEqual(left.map((dot) => dot.timeMs));
  });

  it("should keep buy and sell apart when they share a price bucket", () => {
    const dots = volumeDots({
      ...frame,
      historyWatermarkMs: null,
      minQuantity: 1,
      prints: [print(5_000, 10, 2, "Bid", 1), print(5_000, 10, 8, "Ask", 2)],
    });

    expect(dots.map((dot) => dot.aggressor).sort()).toEqual(["Ask", "Bid"]);
    const ask = dots.find((dot) => dot.aggressor === "Ask");
    const bid = dots.find((dot) => dot.aggressor === "Bid");
    expect((ask?.radius ?? 0) > (bid?.radius ?? 0)).toBe(true);
  });

  it("should mark candles before the oldest retained print as the price path when the window is wider than the buffer", () => {
    const prints = [print(500_000, 10, 5, "Bid", 1)];
    const boundary = tapeBoundaryMs(1_000, prints);

    expect(boundary).toBe(500_000);
    expect(candleIsPriceMark(0, false, boundary)).toBe(true);
    expect(candleIsPriceMark(500_000, false, boundary)).toBe(false);
    expect(candleIsPriceMark(500_000, true, boundary)).toBe(true);
    expect(tradeFlashAlpha(2_000, 0)).toBe(0);
    expect(tradeFlashAlpha(500, 0)).toBeGreaterThan(0);
  });
});

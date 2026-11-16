import { describe, expect, it } from "vitest";

import { fitRange, linearScale, niceTicks, panPriceRange, timeTicks } from "./scale.ts";

describe("linearScale", () => {
  it("should map the domain onto the range when the range is inverted (price up is y down)", () => {
    const y = linearScale(100, 200, 500, 0);

    expect([y.toPx(100), y.toPx(150), y.toPx(200)]).toEqual([500, 250, 0]);
  });

  it("should invert toPx when fromPx is applied", () => {
    const x = linearScale(1000, 2000, 0, 400);

    expect(x.fromPx(x.toPx(1234))).toBeCloseTo(1234);
  });
});

describe("fitRange", () => {
  it("should widen to the minimum span when every value is equal", () => {
    const range = fitRange([100, 100], 0, 8);

    expect(range).toEqual({ low: 96, high: 104 });
  });

  it("should return null when no value is finite", () => {
    expect(fitRange([null, Number.NaN])).toBeNull();
  });
});

describe("panPriceRange", () => {
  it("should show higher prices when the drag is downward and keep the span", () => {
    const next = panPriceRange(100, 140, 12, 90, 150);

    expect(next).toEqual({ low: 112, high: 152 });
  });

  it("should keep a sliver of the data on screen when the drag would push it all off", () => {
    const above = panPriceRange(100, 140, 10_000, 90, 150);
    const below = panPriceRange(100, 140, -10_000, 90, 150);

    expect(above.low).toBeLessThanOrEqual(150 - 1);
    expect(above.high - above.low).toBeCloseTo(40);
    expect(below.high).toBeGreaterThanOrEqual(90 + 1);
    expect(below.high - below.low).toBeCloseTo(40);
  });
});

describe("niceTicks", () => {
  it("should step by a round number when given a range", () => {
    expect(niceTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
  });
});

describe("timeTicks", () => {
  it("should step by a minute when a five-minute window is 400 px wide", () => {
    expect(timeTicks(0, 300_000, 400)).toEqual([0, 60_000, 120_000, 180_000, 240_000, 300_000]);
  });
});

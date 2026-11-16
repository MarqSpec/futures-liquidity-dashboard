import { describe, expect, it } from "vitest";

import { aggregateCandles } from "./candles.ts";

const bar = (t: number, o: number | null, h: number | null, l: number | null, c: number | null, v = 1) => ({
  t,
  d: 1000,
  o,
  h,
  l,
  c,
  v,
  bv: v,
  sv: 0,
  n: 1,
});

describe("aggregateCandles", () => {
  it("should roll one-second bars into one-minute candles when they share a minute", () => {
    const candles = aggregateCandles([bar(60_000, 10, 12, 9, 11), bar(61_000, 11, 15, 11, 14)], null, 200_000);

    expect(candles).toEqual([
      { t: 60_000, d: 60_000, o: 10, h: 15, l: 9, c: 14, v: 2, bv: 2, sv: 0, developing: false },
    ]);
  });

  it("should roll minute bars into a five-minute candle when that interval is requested", () => {
    const five = aggregateCandles(
      [bar(0, 1, 2, 1, 2), bar(60_000, 2, 4, 2, 3), bar(300_000, 3, 3, 3, 3)],
      null,
      600_000,
      300_000,
    );

    expect(five.map((candle) => [candle.t, candle.d, candle.h, candle.c])).toEqual([
      [0, 300_000, 4, 3],
      [300_000, 300_000, 3, 3],
    ]);
  });

  it("should start a new candle when a bar falls in the next minute", () => {
    expect(aggregateCandles([bar(60_000, 1, 1, 1, 1), bar(120_000, 2, 2, 2, 2)], null, 200_000)).toHaveLength(2);
  });

  it("should skip empty bars when they have no prices", () => {
    expect(aggregateCandles([bar(60_000, null, null, null, null)], null, 200_000)).toHaveLength(0);
  });

  it("should include the developing bar and mark its candle developing when the minute is not over", () => {
    const candles = aggregateCandles([bar(60_000, 1, 1, 1, 1)], bar(70_000, 1, 3, 1, 3), 70_500);

    expect([candles[0]?.h, candles[0]?.developing]).toEqual([3, true]);
  });
});

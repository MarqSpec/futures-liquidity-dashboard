import { describe, expect, it } from "vitest";

import { emaTag, LINE_TAG_HEIGHT, lineEndTicks, stackLineTags, vwapTags, type LineWindow } from "./lineTags.ts";
import type { IndicatorSeries } from "./merge.ts";

// reference: REQUIREMENTS.md FR-77, FR-17 (ARCHITECTURE.md D-63)

function series(over: Partial<IndicatorSeries> = {}): IndicatorSeries {
  return { id: "ema48", label: "EMA 48", kind: "ema", tf: 60, warmup: 48, seen: 60, ready: true, points: [[1000, 100], [2000, 102]], ...over };
}

const live: LineWindow = { startMs: 0, endMs: 5000, serverTimeMs: 3000 };

describe("emaTag", () => {
  it("should name the EMA by its period at its last closed value", () => {
    expect(emaTag(series(), live)).toEqual({ key: "ema48", text: "EMA48", priceTicks: 102 });
  });

  it("should end at the developing value when the series carries one", () => {
    expect(emaTag(series({ dev: [103.5] }), live)?.priceTicks).toBe(103.5);
  });

  it("should say it is warming up when the series is not ready", () => {
    expect(emaTag(series({ ready: false }), live)?.text).toBe("EMA48 warm");
  });

  it("should skip trailing null points and give no tag for a series with no value", () => {
    expect(lineEndTicks(series({ points: [[1000, 100], [1500, 101], [2000, null]] }), live)).toBe(101);
    expect(emaTag(series({ points: [], dev: null }), live)).toBeNull();
  });

  it("should end at the line's interpolated value at the window's right edge when panned back from the live edge", () => {
    const panned: LineWindow = { startMs: 0, endMs: 1500, serverTimeMs: 3000 };
    expect(lineEndTicks(series({ dev: [140] }), panned)).toBe(101);
  });

  it("should tag at the developing value when the newest closed point is older than the window but inside one source timeframe", () => {
    const now = 100_000_000;
    const tenMinutes: LineWindow = { startMs: now - 600_000, endMs: now + 30_000, serverTimeMs: now };
    const fifteenMinuteEma = series({ tf: 900, points: [[now - 720_000, 100]], dev: [103] });
    expect(emaTag(fifteenMinuteEma, tenMinutes)?.priceTicks).toBe(103);
    const oneMinute: LineWindow = { startMs: now - 60_000, endMs: now + 3_000, serverTimeMs: now };
    expect(emaTag(series({ tf: 60, points: [[now - 62_000, 100]], dev: [101] }), oneMinute)?.priceTicks).toBe(101);
  });

  it("should give no tag when nothing of the line is visible: one point and no developing value, or every segment left of the window", () => {
    expect(lineEndTicks(series({ points: [[1000, 100]] }), live)).toBeNull();
    expect(lineEndTicks(series({ points: [[1000, 100], [2000, null]] }), live)).toBeNull();
    const leftOfWindow: LineWindow = { startMs: 100_000, endMs: 110_000, serverTimeMs: 111_000 };
    expect(lineEndTicks(series({ points: [[50_000, 100], [60_000, 102]], dev: null }), leftOfWindow)).toBeNull();
  });

  it("should tag a line whose newest point is exactly at the window's left edge, and not one 1 ms before it", () => {
    const window: LineWindow = { startMs: 100_000, endMs: 110_000, serverTimeMs: 111_000 };
    expect(lineEndTicks(series({ points: [[99_000, 100], [100_000, 102]], dev: null }), window)).toBe(102);
    expect(lineEndTicks(series({ points: [[98_999, 100], [99_999, 102]], dev: null }), window)).toBeNull();
  });

  it("should give no tag when the chart is panned to end before the line's first point", () => {
    const before: LineWindow = { startMs: 0, endMs: 500, serverTimeMs: 3000 };
    expect(lineEndTicks(series({ tf: 1, points: [[1000, 100], [2000, 102]] }), before)).toBeNull();
    expect(lineEndTicks(series({ tf: 60, points: [[1000, 100], [2000, 102]] }), before)).toBeNull(); // the first point is within the margin, but the line starts after the edge
  });

  it("should give no tag when the line is not drawn at all, even with a developing value", () => {
    const far: LineWindow = { startMs: 10_000, endMs: 12_000, serverTimeMs: 12_500 };
    expect(emaTag(series({ tf: 1, dev: [103] }), far)).toBeNull();
  });

});

describe("vwapTags", () => {
  it("should give the VWAP and four σ bands when the day has a spread", () => {
    expect(vwapTags({ vwap: 100, stdDev: 3 }).map((tag) => [tag.text, tag.priceTicks])).toEqual([
      ["VWAP", 100],
      ["VWAP+1σ", 103],
      ["VWAP-1σ", 97],
      ["VWAP+2σ", 106],
      ["VWAP-2σ", 94],
    ]);
  });

  it("should give only the VWAP when the spread is zero or missing, and nothing without a VWAP", () => {
    expect(vwapTags({ vwap: 100, stdDev: 0 }).map((tag) => tag.text)).toEqual(["VWAP"]);
    expect(vwapTags({ vwap: 100, stdDev: null }).map((tag) => tag.text)).toEqual(["VWAP"]);
    expect(vwapTags({ vwap: null, stdDev: 3 })).toEqual([]);
  });
});

describe("stackLineTags", () => {
  const spec = (key: string) => ({ key, text: key, priceTicks: 0 });
  const bounds = { top: 0, bottom: 200 };

  it("should leave tags where their lines are when nothing collides", () => {
    const placed = stackLineTags([{ tag: spec("a"), y: 40 }, { tag: spec("b"), y: 100 }], [], bounds);
    expect(placed.map((tag) => tag.y)).toEqual([40, 100]);
  });

  it("should stack tags whose lines coincide so none overlaps another", () => {
    const placed = stackLineTags([{ tag: spec("a"), y: 100 }, { tag: spec("b"), y: 100 }, { tag: spec("c"), y: 101 }], [], bounds);
    const ys = placed.map((tag) => tag.y);
    expect(ys).toHaveLength(3);
    for (let i = 1; i < ys.length; i++) expect((ys[i] ?? 0) - (ys[i - 1] ?? 0)).toBeGreaterThanOrEqual(LINE_TAG_HEIGHT);
  });

  it("should keep clear of a fixed tag such as the last price", () => {
    const placed = stackLineTags([{ tag: spec("a"), y: 100 }], [100], bounds);
    expect(Math.abs((placed[0]?.y ?? 0) - 100)).toBeGreaterThanOrEqual(LINE_TAG_HEIGHT);
  });

  it("should stack upward when the bottom is full, and drop a tag that fits nowhere", () => {
    const crowded = stackLineTags([{ tag: spec("a"), y: 195 }, { tag: spec("b"), y: 196 }], [], bounds);
    expect(crowded.map((tag) => tag.key).sort()).toEqual(["a", "b"]);
    expect(Math.max(...crowded.map((tag) => tag.y))).toBeLessThanOrEqual(200 - LINE_TAG_HEIGHT / 2);
    const tiny = stackLineTags([{ tag: spec("a"), y: 5 }, { tag: spec("b"), y: 6 }], [], { top: 0, bottom: 20 });
    expect(tiny).toHaveLength(1);
  });

  describe("on fractional pixel positions", () => {
    const tall = { top: 0, bottom: 800 };

    it("should return when a tag wanted on a fixed tag sits at the position that froze the browser", () => {
      const fixed = [77.938, 92.938, 107.93836731348047, 122.93836731348047];
      const placed = stackLineTags([{ tag: spec("a"), y: 107.93836731348047 }, { tag: spec("b"), y: 110 }], fixed, tall);
      expect(placed.map((tag) => tag.y)).toEqual([expect.closeTo(137.938367313480, 6), expect.closeTo(152.938367313480, 6)]);
    }, 2000);

    it("should return for the values captured at the pause, 122.93836731348047 taken", () => {
      const fixed = [77.93836731348047, 92.93836731348047, 107.93836731348047, 122.93836731348047];
      const placed = stackLineTags([{ tag: spec("a"), y: 107.93836731348047 }, { tag: spec("b"), y: 110 }], fixed, tall);
      expect(placed.length).toBeGreaterThan(0);
    }, 2000);

    it("should never overlap tags nor fixed tags, over random fractional positions", () => {
      let seed = 239;
      const next = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
      // Full 53-bit mantissa: a 32-bit fraction never triggers the rounding that hung the loop.
      const random = () => next() + next() / 2 ** 32;
      for (let round = 0; round < 500; round++) {
        const fixed = [30, 130, 230].map((y) => y + random() * 5);
        const wanted = Array.from({ length: 1 + Math.floor(random() * 8) }, (_, i) => ({ tag: spec(`t${i}`), y: random() * 300 }));
        const placed = stackLineTags(wanted, fixed, { top: 0, bottom: 300 });
        const ys = [...fixed, ...placed.map((tag) => tag.y)].sort((a, b) => a - b);
        for (let i = 1; i < ys.length; i++) expect((ys[i] ?? 0) - (ys[i - 1] ?? 0)).toBeGreaterThanOrEqual(LINE_TAG_HEIGHT - 1e-6);
      }
    }, 5000);

    it("should drop a tag that fits nowhere on fractional bounds", () => {
      const placed = stackLineTags([{ tag: spec("a"), y: 5.3 }, { tag: spec("b"), y: 6.7 }], [], { top: 0.4, bottom: 20.9 });
      expect(placed).toHaveLength(1);
    });
  });
});

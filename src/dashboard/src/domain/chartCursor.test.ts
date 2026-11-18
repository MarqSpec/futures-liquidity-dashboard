import { describe, expect, it } from "vitest";

import type { Candle } from "./candles.ts";
import {
  chartKeyAction,
  chartKeyHint,
  chartZoomIn,
  chartZoomOut,
  clampCursor,
  cursorFromTime,
  focusedBarReadout,
  footprintCursorBars,
  footprintReadout,
  initialCursor,
  nextAnnouncement,
} from "./chartCursor.ts";

const spec = { tickSize: 0.25, priceDecimals: 2 };
const candles: Candle[] = [
  { t: 1_700_000_000_000, d: 60_000, o: 100, h: 104, l: 99, c: 102, v: 12, bv: 7, sv: 5, developing: false },
  { t: 1_700_000_060_000, d: 60_000, o: 102, h: 110, l: 101, c: 108, v: 20, bv: 11, sv: 9, developing: true },
];
const startMs = candles[0]!.t;
const endMs = candles[1]!.t + candles[1]!.d;
const low = 90;
const high = 120;

describe("chartKeyAction", () => {
  const cursor = { barT: candles[0]!.t, priceTicks: 100 };

  it("should move to the next bar when ArrowRight is pressed", () => {
    expect(chartKeyAction("ArrowRight", false, cursor, candles, startMs, endMs, low, high)).toEqual({
      type: "move",
      cursor: { barT: candles[1]!.t, priceTicks: 100 },
    });
  });

  it("should stay on the last bar when ArrowRight is pressed again", () => {
    const last = { barT: candles[1]!.t, priceTicks: 100 };

    expect(chartKeyAction("ArrowRight", false, last, candles, startMs, endMs, low, high)).toBeNull();
  });

  it("should move to the previous bar when ArrowLeft is pressed", () => {
    const last = { barT: candles[1]!.t, priceTicks: 100 };

    expect(chartKeyAction("ArrowLeft", false, last, candles, startMs, endMs, low, high)).toEqual({
      type: "move",
      cursor: { barT: candles[0]!.t, priceTicks: 100 },
    });
  });

  it("should move one tick up when ArrowUp is pressed", () => {
    expect(chartKeyAction("ArrowUp", false, cursor, candles, startMs, endMs, low, high)).toEqual({
      type: "move",
      cursor: { barT: cursor.barT, priceTicks: 101 },
    });
  });

  it("should not move past the top of the price range when ArrowUp is pressed", () => {
    expect(chartKeyAction("ArrowUp", false, { ...cursor, priceTicks: high }, candles, startMs, endMs, low, high)).toBeNull();
  });

  it("should pan back one bar when Shift+ArrowLeft is pressed", () => {
    expect(chartKeyAction("ArrowLeft", true, cursor, candles, startMs, endMs, low, high)).toEqual({
      type: "pan",
      deltaMs: 60_000,
    });
  });

  it("should pan toward live when Shift+ArrowRight is pressed", () => {
    expect(chartKeyAction("ArrowRight", true, cursor, candles, startMs, endMs, low, high)).toEqual({
      type: "pan",
      deltaMs: -60_000,
    });
  });

  it("should zoom time in when + is pressed", () => {
    expect(chartKeyAction("+", false, cursor, candles, startMs, endMs, low, high)).toEqual({
      type: "zoom-time",
      factor: chartZoomIn,
    });
  });

  it("should zoom time out when - is pressed", () => {
    expect(chartKeyAction("-", false, cursor, candles, startMs, endMs, low, high)).toEqual({
      type: "zoom-time",
      factor: chartZoomOut,
    });
  });

  it("should zoom price in when Shift++ is pressed", () => {
    expect(chartKeyAction("+", true, cursor, candles, startMs, endMs, low, high)).toEqual({
      type: "zoom-price",
      factor: chartZoomIn,
    });
  });

  it("should return to live when Home is pressed", () => {
    expect(chartKeyAction("Home", false, cursor, candles, startMs, endMs, low, high)).toEqual({ type: "reset" });
  });

  it("should ignore a key that is not a chart key", () => {
    expect(chartKeyAction("a", false, cursor, candles, startMs, endMs, low, high)).toBeNull();
  });

  it("should dismiss the cursor when Escape is pressed", () => {
    expect(chartKeyAction("Escape", false, cursor, candles, startMs, endMs, low, high)).toEqual({ type: "dismiss" });
  });
});

describe("clampCursor", () => {
  it("should keep a bar that is still in view", () => {
    expect(clampCursor({ barT: candles[0]!.t, priceTicks: 100 }, candles, startMs, endMs, low, high)).toEqual({
      barT: candles[0]!.t,
      priceTicks: 100,
    });
  });

  it("should snap to the nearest visible bar after the window moves away", () => {
    const start = candles[0]!.t + candles[0]!.d + 1;

    expect(clampCursor({ barT: candles[0]!.t, priceTicks: 100 }, candles, start, start + 60_000, low, high)).toEqual({
      barT: candles[1]!.t,
      priceTicks: 100,
    });
  });
});

describe("focusedBarReadout", () => {
  it("should read the bar OHLC, volume, and the bid and ask at the focused price", () => {
    const text = focusedBarReadout({
      root: "MES",
      spec,
      candle: candles[0]!,
      priceTicks: 100,
      column: { t: candles[0]!.t, d: 60_000, c: [100, 4, 1.5, 60_000] },
    });

    expect(text).toContain("MES");
    expect(text).toContain("OHLC 25.00 / 26.00 / 24.75 / 25.50");
    expect(text).toContain("volume 12");
    expect(text).toContain("25.00 bid 4, ask 1.5, coverage 100 %");
    expect(text).toMatch(/UTC[+-]\d+/);
    expect(chartKeyHint.length).toBeGreaterThan(0);
  });

  it("should say there is no depth when the focused price has no heatmap cell", () => {
    const text = focusedBarReadout({
      root: "MES",
      spec,
      candle: candles[0]!,
      priceTicks: 100,
      column: { t: candles[0]!.t, d: 60_000, c: [90, 1, 1, 60_000] },
    });

    expect(text).toContain("no depth at this price");
  });
});

describe("footprintReadout", () => {
  const bar = { t: 1_700_000_000_000, d: 60_000, o: 100, h: 102, l: 99, cl: 101, v: 21, delta: 5, maxDelta: 6, minDelta: -1, c: [102, 1, 3, 0, 100, 4, 6, 1, 99, 2, 5, 0] };

  it("should read the traded bid and ask of the footprint cell at the focused price, the bar's delta and volume", () => {
    const text = footprintReadout({ root: "MES", spec, bar, priceTicks: 100 });

    expect(text).toContain("MES");
    expect(text).toMatch(/UTC[+-]\d+/);
    expect(text).toContain("volume 21");
    expect(text).toContain("delta +5");
    expect(text).toContain("25.00 traded bid 4 × ask 6");
    expect(text).not.toMatch(/coverage|OHLC|resting/);
  });

  it("should say nothing traded when the focused price has no footprint cell", () => {
    expect(footprintReadout({ root: "MES", spec, bar, priceTicks: 101 })).toContain("25.25 no trades at this price");
    expect(footprintReadout({ root: "MES", spec, bar: null, priceTicks: 101 })).toBe("MES, no footprint bar in view");
  });
});

describe("footprintCursorBars", () => {
  it("should step by each footprint column, the forming one last, and leave out a column with no trades", () => {
    const closed = { t: 0, d: 60_000, o: 10, h: 12, l: 9, cl: 11, v: 4, delta: 1, maxDelta: 1, minDelta: 0, c: [10, 1, 3, 0] };
    const empty = { t: 60_000, d: 60_000, v: 0, delta: 0, maxDelta: 0, minDelta: 0, c: [] };
    const forming = { t: 120_000, d: 60_000, o: 11, h: 13, l: 11, cl: 12, v: 2, delta: -2, maxDelta: 0, minDelta: -2, c: [12, 2, 0, 0] };

    const bars = footprintCursorBars([closed, empty], forming);

    expect(bars.map((item) => [item.t, item.d, item.h, item.l, item.c, item.developing])).toEqual([
      [0, 60_000, 12, 9, 11, false],
      [120_000, 60_000, 13, 11, 12, true],
    ]);
  });
});

describe("cursorFromTime", () => {
  it("should snap the pointer to the nearest bar and a whole tick", () => {
    const cursor = cursorFromTime(candles, startMs, endMs, candles[1]!.t + 1_000, 100.4, low, high);

    expect(cursor).toEqual({ barT: candles[1]!.t, priceTicks: 100 });
  });

  it("should start on the newest bar when the chart is first focused", () => {
    expect(initialCursor(candles, startMs, endMs, low, high)).toEqual({ barT: candles[1]!.t, priceTicks: 108 });
  });
});

describe("nextAnnouncement", () => {
  const first = { text: "bar one", cell: "1:100", at: 1_000 };

  it("should speak immediately when the keyboard moves to another cell", () => {
    const next = nextAnnouncement(first, { text: "bar two", cell: "2:100", at: 1_100, immediate: true });

    expect(next?.text).toBe("bar two");
  });

  it("should stay quiet when the same cell's numbers change again inside the refresh interval", () => {
    expect(nextAnnouncement(first, { text: "bar one, volume 13", cell: "1:100", at: 1_500, immediate: false })).toBeNull();
  });

  it("should speak a changed value once the refresh interval has passed", () => {
    const next = nextAnnouncement(first, { text: "bar one, volume 13", cell: "1:100", at: 3_000, immediate: false });

    expect(next?.text).toBe("bar one, volume 13");
  });

  it("should not speak when the text is unchanged", () => {
    expect(nextAnnouncement(first, { text: "bar one", cell: "1:100", at: 9_000, immediate: true })).toBeNull();
  });
});

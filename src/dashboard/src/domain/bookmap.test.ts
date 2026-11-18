import { describe, expect, it } from "vitest";

import {
  priceSegments,
  FAILED_RECLAIM_NOTE,
  INFERRED_SIGNAL_NOTE,
  NOT_AN_ORDER,
  READ_ONLY_TRAIL,
  WARMUP_NO_L2,
  alignPrices,
  bookmapDockWidths,
  bookmapFrame,
  bookmapLevels,
  bookmapScales,
  brokenMidpoint,
  centerPriceShift,
  pinchAxisFactor,
  clampPriceShift,
  cobColumn,
  dragShiftTicks,
  EVENT_DOT_HIT_MIN_PX,
  eventDotRadius,
  eventHitRadius,
  eventTooltipLines,
  eventUnderPointer,
  failedReclaims,
  guideReclaim,
  heatLevelAlpha,
  hoverReadout,
  lastPriceSteps,
  liveCvdSummary,
  pointerOnPriceLine,
  priceAt,
  priceAxisZoomFactor,
  priceWheelDelta,
  readOnlyTrailGuide,
  sessionVolumeSplit,
  shiftPriceRange,
  sliceVolumeDots,
  stepCenterShift,
  tooltipBox,
  volumeStripBars,
  zoomPriceAbout,
} from "./bookmap.ts";

const spec = { tickSize: 0.25, priceDecimals: 2 };

describe("bookmapFrame", () => {
  it("should keep PRICE, COB and SVP on the plot's price span when a frame is laid out", () => {
    const frame = bookmapFrame(1000, 700);

    expect(frame.price.y).toBe(frame.plot.y);
    expect(frame.cob.y).toBe(frame.plot.y);
    expect(frame.svp.y).toBe(frame.plot.y);
    expect(frame.price.h).toBe(frame.plot.h);
    expect(frame.cob.h).toBe(frame.plot.h);
    expect(frame.svp.h).toBe(frame.plot.h);
  });

  it("should give the plot the stage's whole height and lay out no volume strip or CVD box when the dock below carries them", () => {
    const frame = bookmapFrame(800, 400);

    expect(frame.plot).toEqual({ x: 0, y: 0, w: 800 - (76 + 96 + 96), h: 400 });
    expect(Object.keys(frame).sort()).toEqual(["cob", "plot", "price", "svp"]);
  });

  it("should shrink the dock on a narrow stage so the plot keeps most of the width", () => {
    const wide = bookmapFrame(1000, 600);
    expect(wide.price.w + wide.cob.w + wide.svp.w).toBe(76 + 96 + 96);
    expect(bookmapDockWidths(1000)).toEqual({ price: 76, cob: 96, svp: 96 });

    const narrow = bookmapFrame(360, 640);
    const dock = narrow.price.w + narrow.cob.w + narrow.svp.w;
    expect(dock).toBeLessThan(268);
    expect(narrow.plot.w).toBeGreaterThan(dock);
    expect(narrow.plot.w).toBeGreaterThanOrEqual(360 * 0.55 - 1);
    expect(narrow.cob.x).toBe(narrow.price.x + narrow.price.w);
    expect(narrow.svp.x).toBe(narrow.cob.x + narrow.cob.w);
  });
});

describe("alignPrices", () => {
  it("should put a COB price and the session profile price on the same y as the price scale", () => {
    const frame = bookmapFrame(1000, 600);
    const { price } = bookmapScales(frame, 0, 60_000, 90, 110);
    const cob = cobColumn({
      bookKnown: true,
      depthSubscribed: true,
      bids: [[100, 12]],
      asks: [[101, 9]],
    });
    const svp = sessionVolumeSplit([], [[100, 40]]);

    expect(cob.kind).toBe("book");
    if (cob.kind !== "book") return;
    const cobY = alignPrices(cob.levels, price).find((row) => row.priceTicks === 100)?.y;
    const svpY = alignPrices(svp, price).find((row) => row.priceTicks === 100)?.y;

    expect(cobY).toBe(price.toPx(100));
    expect(svpY).toBe(price.toPx(100));
    expect(cobY).toBe(svpY);
  });
});

describe("shiftPriceRange", () => {
  it("should move both ends by the shift and keep the span", () => {
    expect(shiftPriceRange({ low: 100, high: 140 }, 12)).toEqual({ low: 112, high: 152 });
    expect(shiftPriceRange({ low: 100, high: 140 }, -8)).toEqual({ low: 92, high: 132 });
  });

  it("should leave the range alone when the shift is not a number", () => {
    expect(shiftPriceRange({ low: 100, high: 140 }, Number.NaN)).toEqual({ low: 100, high: 140 });
  });

  it("should keep part of the fitted span on screen when the shift is huge", () => {
    const span = 40;
    const limit = span * 0.85;
    expect(clampPriceShift(10_000, span)).toBeCloseTo(limit);
    expect(clampPriceShift(-10_000, span)).toBeCloseTo(-limit);
    const shifted = shiftPriceRange({ low: 100, high: 140 }, 10_000);
    expect(shifted.high - shifted.low).toBeCloseTo(span);
    expect(shifted.low).toBeLessThan(140);
    expect(shifted.high).toBeGreaterThan(100);
    expect(shifted.low).toBeCloseTo(100 + limit);
  });
});

describe("zoomPriceAbout", () => {
  it("should keep the center price when zooming about the middle", () => {
    const next = zoomPriceAbout(1, 12, 100, 0.5, 0.5);
    expect(next.priceZoom).toBeCloseTo(0.5);
    expect(next.shiftTicks).toBeCloseTo(12);
  });

  it("should keep the price under the pointer when zooming about the top or the bottom", () => {
    const top = zoomPriceAbout(1, 0, 100, 0, 0.5);
    expect(top.shiftTicks).toBeCloseTo(25);
    const bottom = zoomPriceAbout(1, 0, 100, 1, 0.5);
    expect(bottom.shiftTicks).toBeCloseTo(-25);
  });

  it("should stretch when the PRICE axis is dragged up and compress when it is dragged down", () => {
    expect(priceAxisZoomFactor(-90)).toBeCloseTo(Math.exp(-1));
    expect(priceAxisZoomFactor(90)).toBeCloseTo(Math.exp(1));
    expect(zoomPriceAbout(1, 0, 80, 0.5, priceAxisZoomFactor(-90)).priceZoom).toBeLessThan(1);
    expect(zoomPriceAbout(1, 0, 80, 0.5, priceAxisZoomFactor(90)).priceZoom).toBeGreaterThan(1);
  });

  it("should put a price on the midpoint without changing the span", () => {
    const range = { low: 100, high: 200 };
    expect(centerPriceShift(range, 150)).toBe(0);
    const shift = centerPriceShift(range, 180);
    const moved = shiftPriceRange(range, shift);
    expect(moved.high - moved.low).toBe(100);
    expect((moved.low + moved.high) / 2).toBe(180);
    expect(centerPriceShift(range, 10_000)).toBeLessThan(10_000 - 150);
    expect(stepCenterShift(0, 10)).toBeCloseTo(4.5);
    expect(stepCenterShift(9.7, 10)).toBe(10);
  });

  it("should leave a pinch axis alone when the fingers start nearly together", () => {
    expect(pinchAxisFactor(6, 160)).toBe(1);
    expect(pinchAxisFactor(120, 60)).toBe(2);
    expect(pinchAxisFactor(32, 16)).toBe(2);
    expect(pinchAxisFactor(31, 8)).toBe(1);
  });
});

describe("dragShiftTicks", () => {
  it("should turn a downward drag into higher prices, scaled by ticks per pixel", () => {
    // 40 ticks over 400 px is 0.1 tick per pixel.
    expect(dragShiftTicks(50, { low: 100, high: 140 }, 400)).toBeCloseTo(5);
    expect(dragShiftTicks(-50, { low: 100, high: 140 }, 400)).toBeCloseTo(-5);
  });

  it("should not move a plot with no height", () => {
    expect(dragShiftTicks(50, { low: 100, high: 140 }, 0)).toBe(0);
  });
});

describe("priceWheelDelta", () => {
  it("should use the vertical delta, and the horizontal one when Shift turned the wheel sideways", () => {
    expect(priceWheelDelta({ deltaX: 0, deltaY: -40 })).toBe(-40);
    expect(priceWheelDelta({ deltaX: 30, deltaY: 0 })).toBe(30);
    expect(priceWheelDelta({ deltaX: 0, deltaY: 0 })).toBe(0);
  });
});

describe("cobColumn", () => {
  it("should say depth is not subscribed when the server is not receiving the book", () => {
    expect(
      cobColumn({ bookKnown: false, depthSubscribed: false, bids: [[1, 5]], asks: [] }),
    ).toEqual({ kind: "empty", label: "depth not subscribed" });
  });

  it("should say the book is recovering when depth is on and the book is unknown", () => {
    const column = cobColumn({ bookKnown: false, depthSubscribed: true, bids: [], asks: [] });

    expect(column).toEqual({ kind: "empty", label: "book recovering" });
  });

  it("should keep bid and ask size on one price when the book is known", () => {
    const column = cobColumn({
      bookKnown: true,
      depthSubscribed: true,
      bids: [[100, 4], [100, 1]],
      asks: [[100, 7]],
    });

    expect(column).toEqual({ kind: "book", levels: [{ priceTicks: 100, bid: 5, ask: 7 }] });
  });
});

describe("sessionVolumeSplit", () => {
  it("should split footprint buy and sell and leave profile volume the footprints do not cover unsided", () => {
    const rows = sessionVolumeSplit(
      [{ c: [100, 3, 8, 0] }],
      [[100, 20], [99, 4]],
    );

    expect(rows).toEqual([
      { priceTicks: 100, bid: 3, ask: 8, unsided: 9 },
      { priceTicks: 99, bid: 0, ask: 0, unsided: 4 },
    ]);
  });

  it("should leave warmup and prior-session footprints unsided", () => {
    const rows = sessionVolumeSplit(
      [
        { t: 1_000, c: [100, 10, 10, 0] },
        { t: 6_000, c: [100, 7, 1, 0] },
        { t: 9_000, c: [100, 2, 4, 0] },
      ],
      [[100, 40]],
      { historyWatermarkMs: 5_000, sessionOpenMs: 8_000 },
    );

    expect(rows).toEqual([{ priceTicks: 100, bid: 2, ask: 4, unsided: 34 }]);
  });

  it("should leave a gap-repaired footprint unsided", () => {
    const rows = sessionVolumeSplit(
      [
        { t: 9_000, c: [100, 8, 8, 0], approximate: true },
        { t: 9_500, c: [100, 2, 4, 0] },
      ],
      [[100, 40]],
      { historyWatermarkMs: 5_000, sessionOpenMs: 8_000 },
    );

    expect(rows).toEqual([{ priceTicks: 100, bid: 2, ask: 4, unsided: 34 }]);
  });
});

describe("heatLevelAlpha", () => {
  it("should fade a ramp bucket when dimming rises and leave a brighter bucket brighter", () => {
    const dimmed = heatLevelAlpha(4, 8, 0.5);
    expect(heatLevelAlpha(4, 8, 0)).toBeGreaterThan(dimmed);
    expect(dimmed).toBeGreaterThan(heatLevelAlpha(4, 8, 1));
    expect(heatLevelAlpha(7, 8, 0)).toBeGreaterThan(heatLevelAlpha(0, 8, 0));
  });
});

describe("sliceVolumeDots", () => {
  const frame = {
    historyWatermarkMs: null as number | null,
    startMs: 0,
    endMs: 60_000,
    plotWidthPx: 600,
    priceSpanTicks: 20,
    plotHeightPx: 400,
    minQuantity: 1,
  };

  it("should sit one dot on the bucket VWAP and split buy from sell", () => {
    const dots = sliceVolumeDots({
      ...frame,
      prints: [
        { sourceTimeMs: 1_000, priceTicks: 100, quantity: 1, aggressor: "Bid", sequence: 1 },
        { sourceTimeMs: 1_000, priceTicks: 110, quantity: 3, aggressor: "Ask", sequence: 2 },
      ],
    });

    expect(dots).toHaveLength(2);
    expect(dots[0]).toMatchObject({ buy: 1, sell: 0, buyFraction: 1, priceTicks: 100 });
    expect(dots[1]).toMatchObject({ buy: 0, sell: 3, buyFraction: 0, priceTicks: 110 });
  });

  it("should label the large dot and omit a print at the watermark and one below the filter", () => {
    const dots = sliceVolumeDots({
      ...frame,
      historyWatermarkMs: 500,
      minQuantity: 100,
      prints: [
        { sourceTimeMs: 500, priceTicks: 100, quantity: 5_000, aggressor: "Bid", sequence: 1 },
        { sourceTimeMs: 2_000, priceTicks: 100, quantity: 50, aggressor: "Bid", sequence: 2 },
        { sourceTimeMs: 3_000, priceTicks: 100, quantity: 5_000, aggressor: "Bid", sequence: 3 },
      ],
    });

    expect(dots).toHaveLength(1);
    expect(dots[0]?.total).toBe(5_000);
    expect(dots[0]?.label).toBe(true);
  });

  it("should print the quantity only on a dot 18px across or larger when dots of several sizes are drawn", () => {
    const dots = sliceVolumeDots({
      ...frame,
      prints: [
        { sourceTimeMs: 1_000, priceTicks: 100, quantity: 5_000, aggressor: "Bid", sequence: 1 },
        { sourceTimeMs: 20_000, priceTicks: 104, quantity: 2_000, aggressor: "Bid", sequence: 2 },
        { sourceTimeMs: 40_000, priceTicks: 108, quantity: 1_600, aggressor: "Ask", sequence: 3 },
      ],
    });
    const byTotal = (total: number) => dots.find((dot) => dot.total === total);

    expect(byTotal(2_000)?.radius).toBeGreaterThanOrEqual(9);
    expect(byTotal(2_000)?.label).toBe(true);
    expect(byTotal(1_600)?.radius).toBeLessThan(9);
    expect(byTotal(1_600)?.radius).toBeGreaterThan(7);
    expect(byTotal(1_600)?.label).toBe(false);
  });
});

describe("volumeStripBars", () => {
  it("should mark a bar that starts at the watermark as warmup and a later bar as live", () => {
    const bars = volumeStripBars(
      [
        { t: 0, d: 60_000, bv: 4, sv: 1 },
        { t: 60_000, d: 60_000, bv: 2, sv: 9 },
      ],
      0,
    );

    expect(bars[0]?.warmup).toBe(true);
    expect(bars[1]?.warmup).toBe(false);
    expect(bars[1]).toMatchObject({ buy: 2, sell: 9 });
  });
});

describe("failedReclaims", () => {
  const high = { name: "PDH", priceTicks: 100, isHigh: true };

  it("should mark the return when price trades back inside the window", () => {
    const marks = failedReclaims({
      levels: [high],
      historyWatermarkMs: null,
      prints: [
        { sourceTimeMs: 1_000, priceTicks: 102 },
        { sourceTimeMs: 2_000, priceTicks: 108 },
        { sourceTimeMs: 3_000, priceTicks: 100 },
      ],
    });

    expect(marks).toEqual([
      { name: "PDH", levelTicks: 100, timeMs: 3_000, priceTicks: 100, extremeTicks: 108, isHigh: true },
    ]);
    expect(FAILED_RECLAIM_NOTE).toContain("Not a confirmed stop run");
    expect(FAILED_RECLAIM_NOTE).not.toContain("MBO");
  });

  it("should stay empty when the return is after the window", () => {
    const marks = failedReclaims({
      levels: [high],
      historyWatermarkMs: null,
      windowMs: 1_000,
      prints: [
        { sourceTimeMs: 0, priceTicks: 104 },
        { sourceTimeMs: 2_000, priceTicks: 99 },
      ],
    });

    expect(marks).toEqual([]);
  });

  it("should ignore a print at the watermark and a mid that is not an extreme", () => {
    const marks = failedReclaims({
      levels: [
        high,
        { name: "4h mid", priceTicks: 100, isHigh: false },
      ],
      historyWatermarkMs: 1_000,
      prints: [
        { sourceTimeMs: 1_000, priceTicks: 110 },
        { sourceTimeMs: 1_500, priceTicks: 90 },
        { sourceTimeMs: 2_000, priceTicks: 100 },
      ],
    });

    expect(marks).toEqual([]);
  });

  it("should mark a low when price trades below it and comes back", () => {
    const marks = failedReclaims({
      levels: [{ name: "PDL", priceTicks: 80, isHigh: false }],
      historyWatermarkMs: null,
      prints: [
        { sourceTimeMs: 1_000, priceTicks: 70 },
        { sourceTimeMs: 2_000, priceTicks: 81 },
      ],
    });

    expect(marks).toHaveLength(1);
    expect(marks[0]?.extremeTicks).toBe(70);
    expect(marks[0]?.isHigh).toBe(false);
  });

  it("should leave a sustained break unmarked and arm the next breach only after price is back inside", () => {
    const held = [
      { sourceTimeMs: 0, priceTicks: 101 },
      { sourceTimeMs: 60_000, priceTicks: 108 },
      { sourceTimeMs: 130_000, priceTicks: 103 },
      { sourceTimeMs: 200_000, priceTicks: 99 },
    ];

    expect(failedReclaims({ levels: [high], historyWatermarkMs: null, prints: held })).toEqual([]);

    expect(
      failedReclaims({
        levels: [high],
        historyWatermarkMs: null,
        prints: [...held, { sourceTimeMs: 210_000, priceTicks: 106 }, { sourceTimeMs: 220_000, priceTicks: 100 }],
      }),
    ).toEqual([{ name: "PDH", levelTicks: 100, timeMs: 220_000, priceTicks: 100, extremeTicks: 106, isHigh: true }]);
  });

  it("should ignore VAH and VAL and prints at or before the level as-of time", () => {
    expect(
      failedReclaims({
        levels: [
          { name: "VAH", priceTicks: 100, isHigh: true },
          { name: "VAL", priceTicks: 80, isHigh: false },
        ],
        historyWatermarkMs: null,
        prints: [
          { sourceTimeMs: 1_000, priceTicks: 110 },
          { sourceTimeMs: 2_000, priceTicks: 99 },
          { sourceTimeMs: 1_000, priceTicks: 70 },
          { sourceTimeMs: 2_000, priceTicks: 81 },
        ],
      }),
    ).toEqual([]);

    expect(
      failedReclaims({
        levels: [{ name: "PDH", priceTicks: 100, isHigh: true, asOfMs: 5_000 }],
        historyWatermarkMs: null,
        prints: [
          { sourceTimeMs: 1_000, priceTicks: 110 },
          { sourceTimeMs: 2_000, priceTicks: 99 },
          { sourceTimeMs: 6_000, priceTicks: 104 },
          { sourceTimeMs: 7_000, priceTicks: 100 },
        ],
      }),
    ).toEqual([{ name: "PDH", levelTicks: 100, timeMs: 7_000, priceTicks: 100, extremeTicks: 104, isHigh: true }]);
  });

  it("should ignore a prior week low, which the server does not emit", () => {
    const marks = failedReclaims({
      levels: [{ name: "prior week low", priceTicks: 100, isHigh: false }],
      historyWatermarkMs: null,
      prints: [
        { sourceTimeMs: 1_000, priceTicks: 90 },
        { sourceTimeMs: 2_000, priceTicks: 101 },
      ],
    });

    expect(marks).toEqual([]);
  });

  it("should not mark a developing session extreme or an undated swing", () => {
    const marks = failedReclaims({
      levels: [
        { name: "session high", priceTicks: 100, isHigh: true },
        { name: "session low", priceTicks: 90, isHigh: false },
        { name: "swing high", priceTicks: 100, isHigh: true },
        { name: "swing low", priceTicks: 90, isHigh: false },
      ],
      historyWatermarkMs: null,
      prints: [
        { sourceTimeMs: 1_000, priceTicks: 110 },
        { sourceTimeMs: 2_000, priceTicks: 99 },
        { sourceTimeMs: 1_000, priceTicks: 80 },
        { sourceTimeMs: 2_000, priceTicks: 91 },
      ],
    });

    expect(marks).toEqual([]);
  });

  it("should keep the trail guide only while its reclaim is inside the visible window", () => {
    const older = { name: "PDH", levelTicks: 100, timeMs: 1_000, priceTicks: 100, extremeTicks: 108, isHigh: true };
    const newer = { name: "PDL", levelTicks: 80, timeMs: 50_000, priceTicks: 80, extremeTicks: 70, isHigh: false };

    expect(guideReclaim([older, newer], 0, 10_000)).toEqual(older);
    expect(guideReclaim([older, newer], 40_000, 60_000)).toEqual(newer);
    expect(guideReclaim([older, newer], 70_000, 80_000)).toBeNull();
  });
});

describe("readOnlyTrailGuide", () => {
  const reclaim = {
    name: "PDH",
    levelTicks: 100,
    timeMs: 3_000,
    priceTicks: 100,
    extremeTicks: 110,
    isHigh: true,
  };

  it("should guide from the broken midpoint to the nearest LVN below it", () => {
    expect(brokenMidpoint(100, 110)).toBe(105);
    const guide = readOnlyTrailGuide({
      reclaim,
      poc: 70,
      lvn: [90, 120],
      levels: [{ name: "Asia low", priceTicks: 60 }],
    });

    expect(guide?.fromTicks).toBe(105);
    expect(guide?.toTicks).toBe(90);
    expect(guide?.targetName).toBe("LVN");
    expect(guide?.heading).toBe(READ_ONLY_TRAIL);
    expect(guide?.detail.startsWith(NOT_AN_ORDER)).toBe(true);
  });

  it("should use POC when no LVN lies on the return side", () => {
    const guide = readOnlyTrailGuide({
      reclaim,
      poc: 80,
      lvn: [130],
      levels: [],
    });

    expect(guide?.toTicks).toBe(80);
    expect(guide?.targetName).toBe("POC");
  });

  it("should stay absent when no reclaim has occurred", () => {
    expect(readOnlyTrailGuide({ reclaim: null, poc: 80, lvn: [70], levels: [] })).toBeNull();
  });

  it("should stay absent when no structural level lies on the return side", () => {
    expect(
      readOnlyTrailGuide({
        reclaim,
        poc: 200,
        lvn: [130],
        levels: [{ name: "Asia high", priceTicks: 140 }],
      }),
    ).toBeNull();
  });
});

describe("bookmapLevels", () => {
  const profile = { poc: 100, vah: 110, val: 90, hvn: [108], lvn: [92], window: "session", bins: [], total: 1, vaFraction: 0.7, partialSinceMs: null, missingRanges: [], approximateRanges: [] };

  it("should include VAH and VAL in Standard and HVN and LVN from the stored profile", () => {
    const names = bookmapLevels({
      preset: "standard",
      hideValueArea: false,
      keyLevels: [
        { name: "Asia high", priceTicks: 120 },
        { name: "daily open", priceTicks: 101 },
        { name: "PDH", priceTicks: 130 },
      ],
      profile,
      vwapTicks: 99,
    }).map((level) => level.name);

    expect(names).toEqual(expect.arrayContaining(["Asia high", "daily open", "PDH", "VWAP", "POC", "VAH", "VAL", "HVN", "LVN"]));
  });

  it("should leave VAH and VAL out of the RIPS preset and leave the profile values unchanged", () => {
    const before = structuredClone(profile);
    const names = bookmapLevels({
      preset: "rips",
      hideValueArea: false,
      keyLevels: [{ name: "PDL", priceTicks: 70 }],
      profile,
      vwapTicks: 99,
    }).map((level) => level.name);

    expect(names).not.toContain("VAH");
    expect(names).not.toContain("VAL");
    expect(names).toContain("HVN");
    expect(profile).toEqual(before);
  });
});

describe("liveCvdSummary", () => {
  it("should note warmup when the last print is still at the watermark", () => {
    const summary = liveCvdSummary({
      cvd: 12,
      cvdKnown: true,
      historyWatermarkMs: 1_000,
      lastPrint: { sourceTimeMs: 1_000, priceTicks: 50, quantity: 2 },
    });

    expect(summary.note).toBe(WARMUP_NO_L2);
    expect(summary.warmup).toBe(true);
    expect(summary.lastQuantity).toBe(2);
  });

  it("should say the CVD is unknown without inventing a live note", () => {
    const summary = liveCvdSummary({ cvd: 0, cvdKnown: false, historyWatermarkMs: null, lastPrint: null });

    expect(summary.note).toBe("CVD unknown");
  });
});

describe("hoverReadout", () => {
  it("should name the resting size and the slice when the cursor is on a live dot", () => {
    const text = hoverReadout({
      spec,
      timeMs: 2_000,
      priceTicks: 100.2,
      historyWatermarkMs: 500,
      heat: [{ t: 0, d: 5_000, c: [100, 4, 6, 5_000, 101, 90, 1, 5_000] }],
      dots: [
        {
          timeMs: 2_000,
          priceTicks: 100,
          buy: 3,
          sell: 1,
          total: 4,
          buyFraction: 0.75,
          radius: 8,
          label: true,
        },
      ],
      timeBucketMs: 5_000,
    });

    expect(text.warmup).toBe(false);
    expect(text.priceText).toBe("25.00");
    expect(text.bidText).toBe("4");
    expect(text.askText).toBe("6");
    expect(text.sliceText).toContain("buy");
    expect(text.sliceText).toContain("sell");
    expect(text.slice).toEqual({ vwapText: "25.00", buyText: "3", sellText: "1" });
  });

  it("should say there is no L2 when the cursor is in warmup", () => {
    const text = hoverReadout({
      spec,
      timeMs: 100,
      priceTicks: 100,
      historyWatermarkMs: 500,
      heat: [{ t: 0, d: 5_000, c: [100, 40, 1, 5_000] }],
      dots: [],
      timeBucketMs: 1_000,
    });

    expect(text.warmup).toBe(true);
    expect(text.sliceText).toBe(WARMUP_NO_L2);
    expect(text.bidText).toBe(WARMUP_NO_L2);
    expect(text.askText).toBe(WARMUP_NO_L2);
    expect(text.slice).toBeNull();
  });

  it("should ask for a hover when the cursor is off the chart", () => {
    const text = hoverReadout({
      spec,
      timeMs: null,
      priceTicks: null,
      historyWatermarkMs: null,
      heat: [],
      dots: [],
      timeBucketMs: 1_000,
    });

    expect(text.sliceText).toContain("Hover the chart");
    expect(text.slice).toBeNull();
  });

  it("should read resting size from the column under the cursor and not from a later book", () => {
    const text = hoverReadout({
      spec,
      timeMs: 8_000,
      priceTicks: 100,
      historyWatermarkMs: null,
      heat: [
        { t: 0, d: 5_000, c: [100, 4, 6, 5_000] },
        { t: 5_000, d: 5_000, c: [100, 11, 2, 5_000] },
      ],
      dots: [],
      timeBucketMs: 1_000,
    });

    expect(text.bidText).toBe("11");
    expect(text.askText).toBe("2");
  });

  it("should say there is no resting book when no heatmap column covers the cursor", () => {
    const text = hoverReadout({
      spec,
      timeMs: 9_000,
      priceTicks: 100,
      historyWatermarkMs: null,
      heat: [{ t: 0, d: 5_000, c: [100, 4, 6, 5_000] }],
      dots: [],
      timeBucketMs: 1_000,
    });

    expect(text.bidText).toBe("no resting book");
  });

  it("should say there is no depth when the covering column has no cell at the price", () => {
    const text = hoverReadout({
      spec,
      timeMs: 2_000,
      priceTicks: 100,
      historyWatermarkMs: null,
      heat: [{ t: 0, d: 5_000, c: [101, 4, 6, 5_000] }],
      dots: [],
      timeBucketMs: 1_000,
    });

    expect(text.bidText).toBe("no depth at this price");
    expect(text.askText).toBe("no depth at this price");
    expect(text.bidText).not.toBe("0");
  });

  it("should show the last-price step when the pointer is on the line", () => {
    const onLine = hoverReadout({
      spec,
      timeMs: 2_000,
      priceTicks: 100,
      historyWatermarkMs: null,
      heat: [],
      dots: [],
      timeBucketMs: 1_000,
      linePriceTicks: 140,
    });
    const offLine = hoverReadout({
      spec,
      timeMs: 2_000,
      priceTicks: 100,
      historyWatermarkMs: null,
      heat: [],
      dots: [],
      timeBucketMs: 1_000,
      linePriceTicks: null,
    });

    expect(onLine.timeMs).toBe(2_000);
    expect(onLine.priceText).toBe("35.00");
    expect(offLine.priceText).toBe("25.00");
  });

  it("should read resting size at the cursor when the price line is a different price", () => {
    const text = hoverReadout({
      spec,
      timeMs: 2_000,
      priceTicks: 100,
      historyWatermarkMs: null,
      heat: [{ t: 0, d: 5_000, c: [100, 4, 6, 5_000, 140, 1, 2, 5_000] }],
      dots: [],
      timeBucketMs: 1_000,
      linePriceTicks: 140,
    });

    expect(text.priceText).toBe("35.00");
    expect(text.bidText).toBe("4");
    expect(text.askText).toBe("6");
  });

  it("should mark a partly known cell as partial with its coverage", () => {
    const text = hoverReadout({
      spec,
      timeMs: 2_000,
      priceTicks: 100,
      historyWatermarkMs: null,
      heat: [{ t: 0, d: 5_000, c: [100, 4, 6, 2_000] }],
      dots: [],
      timeBucketMs: 1_000,
    });

    expect(text.bidText).toBe("4 · partial 40 %");
    expect(text.askText).toBe("6 · partial 40 %");
  });
});

describe("lastPriceSteps", () => {
  const watermarkMs = 30 * 60_000;

  it("should span the whole window, including the side after the watermark, and hold a quiet stretch", () => {
    const endMs = 4 * 3_600_000;
    const steps = lastPriceSteps(
      [
        { t: 0, d: 60_000, o: 100, c: 110 },
        { t: 3 * 3_600_000, d: 60_000, o: 110, c: 140 },
      ],
      0,
      endMs,
      800,
      endMs,
    );

    expect(steps[0]).toEqual({ timeMs: 0, priceTicks: 100 });
    expect(steps.at(-1)).toEqual({ timeMs: endMs, priceTicks: 140 });
    expect(steps.some((step) => step.timeMs <= watermarkMs)).toBe(true);
    expect(steps.some((step) => step.timeMs > watermarkMs && step.priceTicks === 140)).toBe(true);
    expect(steps.some((step) => step.breakBefore)).toBe(false);
    expect(priceAt(steps, watermarkMs)).toBe(110);
    expect(priceAt(steps, endMs)).toBe(140);
  });

  it("should hold the last trade across a quiet minute and break only a missing range or a session open", () => {
    const minute = 60_000;
    const quiet = [
      { t: 0, d: minute, o: 100, c: 100 },
      { t: minute, d: minute, o: 100, c: 100 },
      { t: 3 * minute, d: minute, o: 100, c: 110 },
      { t: 4 * minute, d: minute, o: 110, c: 110 },
    ];
    const now = 5 * minute;
    const held = lastPriceSteps(quiet, 0, now, 800, now);

    expect(priceSegments(held)).toHaveLength(1);
    expect(priceAt(held, 2.5 * minute)).toBe(100);

    const missing = lastPriceSteps(quiet, 0, now, 800, now, null, { missingRanges: [[2 * minute, 3 * minute]] });
    expect(priceSegments(missing)).toHaveLength(2);
    expect(priceAt(missing, 2.5 * minute)).toBeNull();
    expect(priceAt(missing, 1.5 * minute)).toBe(100);
    expect(priceAt(missing, 4.5 * minute)).toBe(110);

    const session = lastPriceSteps(quiet, 0, now, 800, now, null, { sessionOpenMs: 2.5 * minute });
    expect(priceSegments(session)).toHaveLength(2);
    expect(priceAt(session, 2.5 * minute)).toBeNull();
  });

  it("should show the forming bar's price at the last print and stop at now", () => {
    const bar = 5 * 60_000;
    const now = 12 * 60_000;
    const endMs = now + 2.4 * 60_000;
    const steps = lastPriceSteps(
      [
        { t: 0, d: bar, o: 100, c: 100 },
        { t: bar, d: bar, o: 100, c: 120 },
        { t: 2 * bar, d: bar, o: 120, c: 150 },
      ],
      0,
      endMs,
      800,
      now,
      now,
    );

    expect(priceAt(steps, now)).toBe(150);
    expect(priceAt(steps, 11 * 60_000)).toBe(120);
    expect(steps.every((step) => step.timeMs <= now)).toBe(true);
    expect(steps.at(-1)).toEqual({ timeMs: now, priceTicks: 150 });
  });

  it("should keep the window-start sample when later prices in the first column are the extremes", () => {
    const steps = lastPriceSteps(
      [
        { t: 0, d: 60_000, o: 150, c: 150 },
        { t: 60_000, d: 60_000, o: 150, c: 100 },
        { t: 120_000, d: 60_000, o: 100, c: 500 },
        { t: 180_000, d: 60_000, o: 500, c: 120 },
      ],
      30_000,
      240_000,
      1,
      240_000,
    );

    expect(steps[0]).toEqual({ timeMs: 30_000, priceTicks: 150 });
    expect(steps.map((step) => step.priceTicks)).toContain(500);
    expect(steps.map((step) => step.priceTicks)).toContain(100);
  });

  it("should keep a spike in the first pixel column when the range is decimated", () => {
    const candles = Array.from({ length: 4_000 }, (_, index) => ({
      t: index * 60_000,
      d: 60_000,
      o: 100,
      c: index === 3 ? 500 : 100,
    }));
    const endMs = 4_000 * 60_000;
    const steps = lastPriceSteps(candles, 0, endMs, 800, endMs);

    expect(Math.max(...steps.map((step) => step.priceTicks))).toBe(500);
    expect(steps.length).toBeLessThan(candles.length);
  });

  it("should keep at most the min, max and last sample per pixel and the same samples when only price would move", () => {
    const candles = Array.from({ length: 5_000 }, (_, index) => ({
      t: index * 60_000,
      d: 60_000,
      o: 100 + (index % 7),
      c: 200 + (index % 5),
    }));
    const endMs = 5_000 * 60_000;
    const narrow = lastPriceSteps(candles, 0, endMs, 100, endMs);
    const again = lastPriceSteps(candles, 0, endMs, 100, endMs);
    const wide = lastPriceSteps(candles, 0, endMs, 4_000, endMs);

    expect(narrow.length).toBeLessThanOrEqual(300);
    expect(narrow.length).toBeLessThan(candles.length);
    expect(narrow[0]?.timeMs).toBe(0);
    expect(narrow.at(-1)?.timeMs).toBe(endMs);
    expect(narrow.at(-1)?.priceTicks).toBe(candles.at(-1)?.c);
    expect(again).toEqual(narrow);
    expect(wide.length).toBeGreaterThan(narrow.length);
  });

  it("should call the pointer on the line only when it is within a few pixels", () => {
    const range = { low: 0, high: 100 };
    expect(pointerOnPriceLine(50, 52, range, 200)).toBe(true);
    expect(pointerOnPriceLine(50, 80, range, 200)).toBe(false);
  });
});

describe("eventTooltipLines", () => {
  it("should name an inferred iceberg with its refills and keep a confirmed event filled in words", () => {
    const iceberg = eventTooltipLines(
      {
        kind: "Iceberg",
        name: "Iceberg",
        inferred: true,
        timeMs: 1_700_000_000_000,
        priceTicks: 100,
        side: "Ask",
        quantity: 40,
        refills: 3,
        durationMs: 2500,
        detail: "Refilled at the offer.",
      },
      spec,
    );
    expect(iceberg[0]).toBe("Iceberg");
    expect(iceberg).toContain("Inferred");
    expect(iceberg).toContain("Ask");
    expect(iceberg).toContain("size 40");
    expect(iceberg).toContain("3 refills");
    expect(iceberg).toContain("2.5 s");
    expect(iceberg).toContain("Refilled at the offer.");

    const confirmed = eventTooltipLines(
      { kind: "Spoof", name: "Spoof", inferred: false, timeMs: 1_000, priceTicks: 100 },
      spec,
    );
    expect(confirmed).toContain("Confirmed");
    expect(confirmed).not.toContain("Inferred");
  });

  it("should pick the marker under the pointer and keep the tooltip inside the plot", () => {
    const hit = eventUnderPointer(
      [
        { kind: "Spoof", timeMs: 1, priceTicks: 1 },
        { kind: "Iceberg", timeMs: 2, priceTicks: 2 },
      ],
      10,
      10,
      (event) => (event.kind === "Iceberg" ? { x: 12, y: 11 } : { x: 40, y: 40 }),
    );
    expect(hit?.kind).toBe("Iceberg");
    expect(eventUnderPointer([{ kind: "Spoof", timeMs: 1, priceTicks: 1 }], 0, 0, () => ({ x: 30, y: 30 }))).toBeNull();
    expect(tooltipBox(900, 20, { x: 0, y: 0, w: 500, h: 400 }).left).toBeLessThan(900);
    expect(tooltipBox(10, 390, { x: 0, y: 0, w: 500, h: 400 }).top).toBeLessThan(390);
  });

  it("should keep the event hit area at least the drawn dot and at least a touch minimum", () => {
    expect(eventDotRadius("medium")).toBe(4.5);
    expect(eventHitRadius("small")).toBe(EVENT_DOT_HIT_MIN_PX);
    expect(eventDotRadius("large")).toBeGreaterThan(EVENT_DOT_HIT_MIN_PX);
    expect(eventHitRadius("large")).toBe(eventDotRadius("large"));

    const inside = eventHitRadius("large") - 0.5;
    const marker = [{ kind: "Iceberg", timeMs: 1, priceTicks: 1 }];
    expect(eventUnderPointer(marker, 0, 0, () => ({ x: inside, y: 0 }), eventHitRadius("large"))?.kind).toBe("Iceberg");
    expect(eventUnderPointer(marker, 0, 0, () => ({ x: eventHitRadius("large") + 1, y: 0 }), eventHitRadius("large"))).toBeNull();
  });
});

describe("signal copy", () => {
  it("should keep the advisory note inferred and free of an order", () => {
    expect(INFERRED_SIGNAL_NOTE).toContain("Inferred from prints and book changes");
    expect(INFERRED_SIGNAL_NOTE).toContain(NOT_AN_ORDER);
    expect(INFERRED_SIGNAL_NOTE).not.toContain("MBO");
  });
});

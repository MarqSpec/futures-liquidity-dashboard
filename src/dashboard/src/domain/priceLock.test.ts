import { describe, expect, it } from "vitest";

import type { Candle } from "./candles.ts";
import { LOCK_RELEASE_DRAG_PX, PINCH_PRICE_DEADBAND_PX } from "./bookmap.ts";
import { dragReleasesLock, lastPriceAnchor, pinchZoomsPrice } from "./priceLock.ts";

describe("dragReleasesLock", () => {
  it("should keep the lock when a plot drag has moved less than the release distance vertically", () => {
    expect(dragReleasesLock(200, 200)).toBe(false);
    expect(dragReleasesLock(200, 200 + LOCK_RELEASE_DRAG_PX - 1)).toBe(false);
    expect(dragReleasesLock(200, 200 - (LOCK_RELEASE_DRAG_PX - 1))).toBe(false);
  });

  it("should release the lock when a plot drag reaches the release distance vertically, up or down", () => {
    expect(dragReleasesLock(200, 200 + LOCK_RELEASE_DRAG_PX)).toBe(true);
    expect(dragReleasesLock(200, 200 - LOCK_RELEASE_DRAG_PX)).toBe(true);
  });

  it("should keep the lock when the pointer position is not a number", () => {
    expect(dragReleasesLock(200, Number.NaN)).toBe(false);
  });
});

describe("pinchZoomsPrice", () => {
  it("should not zoom price when the vertical gap moves by less than the deadband", () => {
    expect(pinchZoomsPrice(120, 120)).toBe(false);
    expect(pinchZoomsPrice(120, 120 + PINCH_PRICE_DEADBAND_PX - 1)).toBe(false);
    expect(pinchZoomsPrice(120, 120 - (PINCH_PRICE_DEADBAND_PX - 1))).toBe(false);
  });

  it("should zoom price when the vertical gap moves by the deadband or more", () => {
    expect(pinchZoomsPrice(120, 120 + PINCH_PRICE_DEADBAND_PX)).toBe(true);
    expect(pinchZoomsPrice(120, 120 - PINCH_PRICE_DEADBAND_PX)).toBe(true);
  });
});

describe("lastPriceAnchor", () => {
  const candle = (c: number): Candle => ({ t: 0, d: 60_000, o: c, h: c, l: c, c, v: 1, bv: 1, sv: 0, developing: false });

  it("should take the last print's price when there is a print", () => {
    expect(lastPriceAnchor([{ priceTicks: 101 }, { priceTicks: 104 }], [candle(99)])).toBe(104);
  });

  it("should take the last candle's close when there is no print", () => {
    expect(lastPriceAnchor([], [candle(97), candle(99)])).toBe(99);
  });

  it("should be null before the first trade", () => {
    expect(lastPriceAnchor([], [])).toBeNull();
  });
});

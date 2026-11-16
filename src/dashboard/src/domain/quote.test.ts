import { describe, expect, it } from "vitest";

import { nearestLevelText, sessionChange, vwapPosition } from "./quote.ts";

describe("vwapPosition", () => {
  it("should say how many ticks above VWAP the last price is", () => {
    expect(vwapPosition(105, 100.2)).toBe("VWAP +5t");
  });

  it("should say at VWAP when the last price rounds onto it", () => {
    expect(vwapPosition(100, 100.4)).toBe("at VWAP");
  });

  it("should stay blank when VWAP has no volume", () => {
    expect(vwapPosition(100, null)).toBe("VWAP —");
  });
});

describe("sessionChange", () => {
  it("should print a signed price change when the session has an open", () => {
    expect(sessionChange(4, 0.25, 2)).toBe("+1.00");
    expect(sessionChange(-2, 0.25, 2)).toBe("−0.50");
  });
});

describe("nearestLevelText", () => {
  it("should call out the third touch when that is the nearest level", () => {
    expect(
      nearestLevelText({
        nearestLevel: "VAL",
        nearestTouches: 3,
        nearestIsThirdTouch: true,
        instrument: { root: "MES", name: "", exchange: "", contractId: "", expiry: "", tickSize: 0.25, tickValue: 1.25, priceDecimals: 2, sector: "Equity index" },
      }),
    ).toBe("VAL · 3rd touch");
  });
});

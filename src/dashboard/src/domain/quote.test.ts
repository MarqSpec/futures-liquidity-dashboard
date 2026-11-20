import { describe, expect, it } from "vitest";

import type { InstrumentSummary, LevelTouch } from "../api/schemas.ts";
import { instrumentSummaryFixture } from "../test/fixtures.ts";
import { nearestLevelText, recentTouches, sessionChange, touchOutcomeText, vwapPosition } from "./quote.ts";

// Touch outcomes and the lane order. (REQUIREMENTS.md FR-79)
function touch(name: string, lastTouchMs: number | null, overrides: Partial<LevelTouch> = {}): LevelTouch {
  return { name, priceTicks: 100, isHigh: true, touches: 1, lastTouchMs, isThirdTouch: false, held: 1, broke: 0, ...overrides };
}

function quote(root: string, levels: LevelTouch[]): InstrumentSummary {
  return { ...instrumentSummaryFixture({ root }), levels };
}

const lane = (quotes: InstrumentSummary[], starred: string[]) => recentTouches(quotes, starred).map((t) => `${t.root} ${t.level.name}`);


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

describe("touchOutcomeText", () => {
  it("should say how many touches held and how many broke when the level has been touched", () => {
    expect(touchOutcomeText(touch("PDH", 5, { touches: 2, held: 1, broke: 1 }))).toBe("2 touches · 1 held · 1 broke");
  });

  it("should call out the third touch and keep its outcome when it is the third", () => {
    expect(touchOutcomeText(touch("PDH", 5, { touches: 3, isThirdTouch: true, held: 3, broke: 0 }))).toBe("3rd touch · 3 held · 0 broke");
  });

  it("should say one touch in the singular when there has been one", () => {
    expect(touchOutcomeText(touch("PDH", 5))).toBe("1 touch · 1 held · 0 broke");
  });

  it("should say no touch yet when price has not reached the level", () => {
    expect(touchOutcomeText(touch("PDH", null, { touches: 0, held: 0, broke: 0 }))).toBe("no touch yet");
  });
});

describe("recentTouches", () => {
  it("should list starred products first and then the most recent touch when both kinds have touches", () => {
    const quotes = [quote("NQ", [touch("PDH", 300)]), quote("MES", [touch("PDL", 100)]), quote("CL", [touch("VWAP", 200)])];

    expect(lane(quotes, ["MES"])).toEqual(["MES PDL", "NQ PDH", "CL VWAP"]);
  });

  it("should order starred touches by the most recent when several starred products have touches", () => {
    const quotes = [quote("MES", [touch("PDL", 100)]), quote("MGC", [touch("PDH", 200)])];

    expect(lane(quotes, ["MES", "MGC"])).toEqual(["MGC PDH", "MES PDL"]);
  });

  it("should keep the same order when a refresh lists the products in another order with equal touch times", () => {
    const a = quote("MES", [touch("PDH", 100), touch("Asia low", 100)]);
    const b = quote("MCL", [touch("PDH", 100)]);

    expect(lane([a, b], [])).toEqual(lane([b, a], []));
    expect(lane([a, b], [])).toEqual(["MCL PDH", "MES Asia low", "MES PDH"]);
  });

  it("should leave out a level price has not touched", () => {
    expect(lane([quote("MES", [touch("PDH", null, { touches: 0, held: 0, broke: 0 })])], ["MES"])).toEqual([]);
  });
});

describe("nearestLevelText outcome", () => {
  it("should add the nearest level's outcome when the quote lists that level", () => {
    const level = touch("VAL", 5, { priceTicks: 100, touches: 2, held: 1, broke: 1 });
    const text = nearestLevelText({ ...quote("MES", [touch("VAL", 5, { priceTicks: 90 }), level]), nearestLevel: "VAL", nearestTouches: 2, lastTicks: 103, nearestDistanceTicks: 3 });

    expect(text).toBe("VAL · 2 touches · 1 held · 1 broke");
  });
});

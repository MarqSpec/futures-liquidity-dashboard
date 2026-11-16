import { describe, expect, it } from "vitest";

import { regimeFixture } from "../test/fixtures.ts";
import { regimeAgreement, regimeLabel, regimeTitle, regimeTone, timeframeLabel } from "./regime.ts";

const up = regimeFixture(300, { trend: "TrendingUp" });
const down = regimeFixture(900, { trend: "TrendingDown" });
const range = regimeFixture(900, { trend: "Ranging" });
const unclear = regimeFixture(900, { trend: "Transition" });
const warming = regimeFixture(900, { trend: "Unknown", ready: false, seenBars: 7, warmupBars: 28 });

describe("regimeAgreement", () => {
  it("should agree when both timeframes trend up", () => {
    expect(regimeAgreement(up, regimeFixture(900, { trend: "TrendingUp" }))).toBe("agree");
  });

  it("should agree when both timeframes range", () => {
    expect(regimeAgreement(regimeFixture(300), range)).toBe("agree");
  });

  it("should conflict when one trends up and the other down", () => {
    expect(regimeAgreement(up, down)).toBe("conflict");
  });

  it("should conflict when one trends and the other ranges", () => {
    expect(regimeAgreement(up, range)).toBe("conflict");
  });

  it.each([
    ["unclear", unclear],
    ["warming up", warming],
    ["missing", null],
  ])("should be mixed when the other timeframe is %s", (_name, other) => {
    expect(regimeAgreement(up, other)).toBe("mixed");
  });

  it("should be mixed when a trend is named but the regime is not ready", () => {
    expect(regimeAgreement(up, regimeFixture(900, { trend: "TrendingUp", ready: false }))).toBe("mixed");
  });
});

describe("regimeLabel", () => {
  it.each([
    [up, "Trend ↑"],
    [down, "Trend ↓"],
    [range, "Range"],
    [unclear, "Unclear"],
    [warming, "Warming 7/28"],
    [null, "—"],
  ] as const)("should label the regime as the short text %#", (regime, label) => {
    expect(regimeLabel(regime)).toBe(label);
  });
});

describe("regimeTone", () => {
  it("should be the warming tone when the regime is not ready", () => {
    expect(regimeTone(warming)).toBe("warming");
  });

  it("should be the down tone when the price trends down", () => {
    expect(regimeTone(down)).toBe("down");
  });
});

describe("regimeTitle", () => {
  it("should show ADX, ER and both EMAs as prices when they are known", () => {
    const title = regimeTitle(regimeFixture(300, { adx: 31.24, efficiencyRatio: 0.584, emaFast: 27_090, emaSlow: 27_052 }), {
      tickSize: 0.25,
      priceDecimals: 2,
    });

    expect(title).toMatch(/^5m Range · ADX 31\.2 · ER 0\.58 · EMA fast 6772\.50 \/ slow 6763\.00 · since /);
  });

  it("should show dashes when a warming regime has no inputs yet", () => {
    expect(regimeTitle({ ...warming, adx: null, efficiencyRatio: null, sinceMs: null }, { tickSize: 1, priceDecimals: 0 })).toContain(
      "ADX — · ER —",
    );
  });
});

describe("timeframeLabel", () => {
  it("should name minutes and hours when the seconds divide evenly", () => {
    expect([timeframeLabel(300), timeframeLabel(900), timeframeLabel(3600), timeframeLabel(45)]).toEqual(["5m", "15m", "1h", "45s"]);
  });
});

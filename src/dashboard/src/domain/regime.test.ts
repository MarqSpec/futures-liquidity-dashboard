import { describe, expect, it } from "vitest";

import { regimeFixture } from "../test/fixtures.ts";
import { regimeAgreement, regimeExplanation, regimeLabel, regimeTitle, regimeTone, timeframeLabel } from "./regime.ts";

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

describe("regimeExplanation", () => {
  const spec = { tickSize: 0.25, priceDecimals: 2 };
  const text = (overrides: Parameters<typeof regimeFixture>[1]) => regimeExplanation(regimeFixture(300, overrides), spec).join("\n");

  it("should give a range's ADX and efficiency ratio beside the range limits it met", () => {
    const lines = text({ basis: "RangeMet", adx: 18.46, efficiencyRatio: 0.153 });

    expect(lines).toContain("Range: ADX 18.46 is at or under 20 and the efficiency ratio 0.153 is at or under 0.2.");
  });

  it("should give a trend's inputs, both trend limits and the direction that agreed", () => {
    const lines = text({ trend: "TrendingUp", basis: "TrendMet", adx: 31.24, efficiencyRatio: 0.584, plusDi: 30.1, minusDi: 12 });

    expect(lines).toContain("Trending up: ADX 31.24 is at or over 25 and the efficiency ratio 0.584 is at or over 0.3");
    expect(lines).toContain("+DI 30.10 is over -DI 12.00");
  });

  it("should say a downtrend's -DI is over +DI", () => {
    expect(text({ trend: "TrendingDown", basis: "TrendMet", plusDi: 10, minusDi: 25 })).toContain("-DI 25.00 is over +DI 10.00");
  });

  it("should say the direction disagreed when the trend limits were met but the signals point opposite ways", () => {
    expect(text({ trend: "Transition", basis: "DirectionDisagrees", adx: 30, efficiencyRatio: 0.5 })).toContain(
      "Unclear: ADX 30.00 and the efficiency ratio 0.500 meet the trend limits (25, 0.3), but +DI/-DI and the EMAs do not point the same way.",
    );
  });

  it("should give both pairs of limits when the regime sits between them", () => {
    expect(text({ trend: "Transition", basis: "Between", adx: 22, efficiencyRatio: 0.25 })).toContain(
      "Unclear: ADX 22.00 and the efficiency ratio 0.250 are not both over the trend limits (25, 0.3) and not both under the range limits (20, 0.2).",
    );
  });

  it("should say how many bars are in while warming up, and show no limits it was not given", () => {
    const lines = regimeExplanation(regimeFixture(300, { trend: "Unknown", ready: false, basis: "Warmup", seenBars: 9, warmupBars: 28, adx: null }), spec);

    expect(lines[0]).toBe("5m Warming 9/28");
    expect(lines.join("\n")).toContain("Warming up: 9 of 28 closed bars are in.");
  });

  it("should list every input, with the EMAs as prices", () => {
    const lines = text({ adx: 31.24, efficiencyRatio: 0.584, plusDi: 30.1, minusDi: 12, emaFast: 27_090, emaSlow: 27_052 });

    expect(lines).toContain("ADX 31.24 · efficiency ratio 0.584 · +DI 30.10 · -DI 12.00 · EMA fast 6772.50 / slow 6763.00");
  });

  it("should still explain a regime from an older server that sends no basis or limits", () => {
    const lines = regimeExplanation(regimeFixture(300, { basis: "Warmup", thresholds: null, trend: "Ranging" }), spec).join("\n");

    expect(lines).toContain("Limits not published by this server.");
  });

  // The hint must never contradict its own numbers: thresholds print as sent, inputs at the server's precision
  // (ADX and DI to 2 places, the efficiency ratio to 3; RegimeTracker.State).
  it("should print a configured threshold exactly as the server sends it, not rounded", () => {
    const thresholds = { trendAdx: 22.5, trendEfficiency: 0.35, rangeAdx: 20.4, rangeEfficiency: 0.15 };

    expect(text({ basis: "RangeMet", adx: 20.35, efficiencyRatio: 0.12, thresholds })).toContain(
      "Range: ADX 20.35 is at or under 20.4 and the efficiency ratio 0.120 is at or under 0.15.",
    );
    expect(text({ trend: "Transition", basis: "Between", adx: 22.49, efficiencyRatio: 0.4, thresholds })).toContain(
      "not both over the trend limits (22.5, 0.35) and not both under the range limits (20.4, 0.15).",
    );
  });

  it("should not print an efficiency ratio just under the trend limit as the limit itself", () => {
    const lines = text({ trend: "Transition", basis: "Between", adx: 30, efficiencyRatio: 0.296 });

    expect(lines).toContain("Unclear: ADX 30.00 and the efficiency ratio 0.296 are not both over the trend limits (25, 0.3)");
    expect(lines).not.toContain("0.30 ");
  });

  it("should not print an ADX just under the trend limit as the limit itself", () => {
    const lines = text({ trend: "Transition", basis: "Between", adx: 24.97, efficiencyRatio: 0.5 });

    expect(lines).toContain("Unclear: ADX 24.97 and the efficiency ratio 0.500 are not both over the trend limits (25, 0.3)");
  });

  it("should not print an efficiency ratio just over the range limit as the limit itself", () => {
    const lines = text({ trend: "Transition", basis: "Between", adx: 18, efficiencyRatio: 0.204 });

    expect(lines).toContain("Unclear: ADX 18.00 and the efficiency ratio 0.204 are not both over");
  });

  it("should not print two close DI readings as equal when one is over the other", () => {
    expect(text({ trend: "TrendingUp", basis: "TrendMet", adx: 30, efficiencyRatio: 0.5, plusDi: 12.04, minusDi: 12.01 })).toContain(
      "+DI 12.04 is over -DI 12.01",
    );
  });

  it("should say the server named a test this dashboard does not read, apart from an older server's missing limits", () => {
    const lines = regimeExplanation(regimeFixture(300, { trend: "Ranging", basis: "Unknown" }), spec);

    expect(lines[1]).toBe("The server named a test this dashboard does not read; its inputs are below.");
    expect(lines.join(" ")).not.toContain("Warming up");
    expect(lines.join(" ")).not.toContain("Limits not published");
  });

  it("should say no regime is published when there is none", () => {
    expect(regimeExplanation(null, spec)).toEqual(["No regime published for this timeframe"]);
  });
});

describe("timeframeLabel", () => {
  it("should name minutes and hours when the seconds divide evenly", () => {
    expect([timeframeLabel(300), timeframeLabel(900), timeframeLabel(3600), timeframeLabel(45)]).toEqual(["5m", "15m", "1h", "45s"]);
  });
});

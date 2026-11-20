import { describe, expect, it } from "vitest";

import type { Profile, Vwap } from "../api/schemas.ts";
import { regimeFixture } from "../test/fixtures.ts";
import { conditionIds, conditionsFor, readingText, type Condition, type ConditionId, type ConditionInputs } from "./conditions.ts";
import type { IndicatorSeries } from "./merge.ts";

// The Conditions panel's fixed states (REQUIREMENTS.md FR-81, UC-21). Synthetic values only.

const spec = { tickSize: 0.25, priceDecimals: 2 };
const closeMs = 1_794_114_960_000;

function series(id: string, values: readonly (number | null)[], overrides: Partial<IndicatorSeries> = {}): IndicatorSeries {
  return { id, label: id, kind: "ema", tf: 60, warmup: 13, seen: 40, ready: true, points: [[closeMs - 60_000, 1, 1, 1], [closeMs, ...values]], dev: null, ...overrides };
}

const vwap: Vwap = { vwap: 20_000.5, stdDev: 4, volume: 1_000, partial: false, anchor: "2026-11-19" };

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    window: "session",
    bins: [],
    total: 1_000,
    poc: 20_010,
    vah: 20_020,
    val: 19_990,
    vaFraction: 0.7,
    partialSinceMs: null,
    missingRanges: [],
    approximateRanges: [],
    hvn: [],
    lvn: [],
    ...overrides,
  };
}

function inputs(overrides: Partial<ConditionInputs> = {}): ConditionInputs {
  return {
    indicators: [series("ema13", [20_012]), series("ema48", [20_004]), series("rsi14", [61.2]), series("macd", [3, 1, 2])],
    indicatorMinutes: 1,
    vwap,
    book: { bestBid: 20_008, bestAsk: 20_009, quoteStale: false },
    profiles: [profile()],
    regimes: [regimeFixture(300, { trend: "TrendingUp" }), regimeFixture(900)],
    spec,
    ...overrides,
  };
}

function condition(list: readonly Condition[], id: ConditionId): Condition {
  const found = list.find((item) => item.id === id);
  if (!found) throw new Error(`no condition ${id}`);
  return found;
}

function state(list: readonly Condition[], id: ConditionId): string {
  return readingText(condition(list, id).reading);
}

describe("conditionsFor", () => {
  it("should list the fixed set in a fixed order, each with a definition, when every input is ready", () => {
    const list = conditionsFor(inputs());

    expect(list.map((item) => item.id)).toEqual([...conditionIds]);
    expect(conditionIds).toEqual(["price-vwap", "ema-13-48", "rsi-50", "macd-signal", "price-poc", "price-value-area", "regime-5m", "regime-15m"]);
    for (const item of list) {
      expect(item.definition.length, item.id).toBeGreaterThan(20);
      expect(item.name.length, item.id).toBeGreaterThan(0);
    }
  });

  it("should state above, below or at for price against VWAP when the best bid, best ask or spread holds it", () => {
    expect(state(conditionsFor(inputs({ book: { bestBid: 20_001, bestAsk: 20_002, quoteStale: false } })), "price-vwap")).toBe("above");
    expect(state(conditionsFor(inputs({ book: { bestBid: 19_999, bestAsk: 20_000, quoteStale: false } })), "price-vwap")).toBe("below");
    expect(state(conditionsFor(inputs({ book: { bestBid: 20_000, bestAsk: 20_001, quoteStale: false } })), "price-vwap")).toBe("at");
  });

  it("should state at for price against VWAP when the VWAP equals the best bid or the best ask", () => {
    const onBid = conditionsFor(inputs({ vwap: { ...vwap, vwap: 20_008 } }));
    const onAsk = conditionsFor(inputs({ vwap: { ...vwap, vwap: 20_009 } }));

    expect(state(onBid, "price-vwap")).toBe("at");
    expect(state(onAsk, "price-vwap")).toBe("at");
  });

  it("should read partial, never a state, when the VWAP is missing trade coverage", () => {
    const reading = condition(conditionsFor(inputs({ vwap: { ...vwap, partial: true } })), "price-vwap").reading;

    expect(reading.kind).toBe("partial");
    expect(readingText(reading)).toBe("partial");
  });

  it("should read unavailable when there is no VWAP or no quote", () => {
    expect(condition(conditionsFor(inputs({ vwap: { ...vwap, vwap: null, volume: 0 } })), "price-vwap").reading).toEqual({ kind: "unavailable", reason: "no VWAP yet" });
    expect(condition(conditionsFor(inputs({ vwap: { ...vwap, vwap: Number.NaN } })), "price-vwap").reading).toEqual({ kind: "unavailable", reason: "no VWAP yet" });
    const noAsk = conditionsFor(inputs({ book: { bestBid: 20_008, bestAsk: null, quoteStale: false } }));
    expect(condition(noAsk, "price-vwap").reading).toEqual({ kind: "unavailable", reason: "no quote" });
    expect(condition(noAsk, "price-poc").reading).toEqual({ kind: "unavailable", reason: "no quote" });
    expect(condition(noAsk, "price-value-area").reading).toEqual({ kind: "unavailable", reason: "no quote" });
  });

  it("should read stale, never a state, for every book comparison when the quote is stale", () => {
    const list = conditionsFor(inputs({ book: { bestBid: 20_008, bestAsk: 20_009, quoteStale: true } }));

    for (const id of ["price-vwap", "price-poc", "price-value-area"] as const) {
      expect(condition(list, id).reading, id).toEqual({ kind: "stale" });
    }
    expect(readingText({ kind: "stale" })).toBe("stale quote");
  });

  it("should state above, below or at for EMA 13 against EMA 48 from the last closed values", () => {
    const at = (fast: number, slow: number) => state(conditionsFor(inputs({ indicators: [series("ema13", [fast]), series("ema48", [slow])] })), "ema-13-48");

    expect(at(20_012, 20_004)).toBe("above");
    expect(at(20_004, 20_012)).toBe("below");
    expect(at(20_004, 20_004)).toBe("at");
  });

  it("should never use the developing value when it disagrees with the closed one", () => {
    const list = conditionsFor(
      inputs({
        indicators: [series("ema13", [20_012], { dev: [19_000] }), series("ema48", [20_004], { dev: [21_000] }), series("rsi14", [61.2], { dev: [10] }), series("macd", [3, 1, 2], { dev: [-5, 5, -10] })],
      }),
    );

    expect(state(list, "ema-13-48")).toBe("above");
    expect(state(list, "rsi-50")).toBe("above");
    expect(state(list, "macd-signal")).toBe("above");
  });

  it("should read warming with the slower series' counts when EMA 48 is still warming up", () => {
    const list = conditionsFor(inputs({ indicators: [series("ema13", [20_012]), series("ema48", [null], { ready: false, seen: 20, warmup: 48 })] }));
    const reading = condition(list, "ema-13-48").reading;

    expect(reading).toEqual({ kind: "warming", seen: 20, warmup: 48 });
    expect(readingText(reading)).toBe("warming 20/48");
  });

  it("should read warming for RSI and MACD when either is not ready", () => {
    const list = conditionsFor(inputs({ indicators: [series("rsi14", [61.2], { ready: false, seen: 9, warmup: 15 }), series("macd", [3, 1, 2], { ready: false, seen: 9, warmup: 34 })] }));

    expect(condition(list, "rsi-50").reading).toEqual({ kind: "warming", seen: 9, warmup: 15 });
    expect(condition(list, "macd-signal").reading).toEqual({ kind: "warming", seen: 9, warmup: 34 });
  });

  it("should read unavailable, never falling back to the developing value, when an indicator is not published or has no closed value", () => {
    const list = conditionsFor(inputs({ indicators: [series("rsi14", [null], { dev: [70] }), series("macd", [3, null, null], { dev: [3, 1, 2] })] }));

    expect(condition(list, "ema-13-48").reading).toEqual({ kind: "unavailable", reason: "not published" });
    expect(condition(list, "rsi-50").reading).toEqual({ kind: "unavailable", reason: "no closed value" });
    expect(condition(list, "macd-signal").reading).toEqual({ kind: "unavailable", reason: "no closed value" });
  });

  it("should state above, below or at for RSI 14 against 50", () => {
    const rsi = (value: number) => state(conditionsFor(inputs({ indicators: [series("rsi14", [value])] })), "rsi-50");

    expect(rsi(50.1)).toBe("above");
    expect(rsi(49.9)).toBe("below");
    expect(rsi(50)).toBe("at");
  });

  it("should state above, below or at for the MACD line against its signal", () => {
    const macd = (line: number, signal: number) => state(conditionsFor(inputs({ indicators: [series("macd", [line, signal, line - signal])] })), "macd-signal");

    expect(macd(-1, -3)).toBe("above");
    expect(macd(-3, -1)).toBe("below");
    expect(macd(2, 2)).toBe("at");
  });

  it("should state above, below or at for price against the session POC", () => {
    const poc = (bid: number) => state(conditionsFor(inputs({ book: { bestBid: bid, bestAsk: bid + 1, quoteStale: false } })), "price-poc");

    expect(poc(20_011)).toBe("above");
    expect(poc(20_008)).toBe("below");
    expect(poc(20_010)).toBe("at");
    expect(poc(20_009)).toBe("at");
  });

  it("should read the session profile, not another window, for the POC and value area", () => {
    const list = conditionsFor(inputs({ profiles: [profile({ window: "1h", poc: 10_000, vah: 10_010, val: 9_990 }), profile()] }));

    expect(state(list, "price-poc")).toBe("below");
    expect(state(list, "price-value-area")).toBe("inside");
  });

  it("should state above, below, inside or at for price against the value area", () => {
    const area = (bid: number, ask: number) => state(conditionsFor(inputs({ book: { bestBid: bid, bestAsk: ask, quoteStale: false } })), "price-value-area");

    expect(area(20_021, 20_022)).toBe("above");
    expect(area(19_988, 19_989)).toBe("below");
    expect(area(19_990, 20_020)).toBe("inside");
    expect(area(20_020, 20_021)).toBe("at");
    expect(area(19_989, 19_990)).toBe("at");
  });

  it("should read partial when the session profile is partial, and unavailable when it has no POC or value area", () => {
    const partial = conditionsFor(inputs({ profiles: [profile({ partialSinceMs: closeMs })] }));
    expect(condition(partial, "price-poc").reading).toEqual({ kind: "partial" });
    expect(condition(partial, "price-value-area").reading).toEqual({ kind: "partial" });

    const empty = conditionsFor(inputs({ profiles: [profile({ poc: null, vah: null, val: null })] }));
    expect(condition(empty, "price-poc").reading).toEqual({ kind: "unavailable", reason: "no session profile" });
    expect(condition(empty, "price-value-area").reading).toEqual({ kind: "unavailable", reason: "no session profile" });

    const none = conditionsFor(inputs({ profiles: [] }));
    expect(condition(none, "price-poc").reading).toEqual({ kind: "unavailable", reason: "no session profile" });
  });

  it("should take each regime from the server's FR-56 trend, never deriving one", () => {
    const list = conditionsFor(inputs({ regimes: [regimeFixture(300, { trend: "TrendingDown" }), regimeFixture(900, { trend: "Transition" })] }));

    expect(state(list, "regime-5m")).toBe("trending down");
    expect(state(list, "regime-15m")).toBe("unclear");
    expect(state(conditionsFor(inputs()), "regime-5m")).toBe("trending up");
    expect(state(conditionsFor(inputs()), "regime-15m")).toBe("ranging");
  });

  it("should read warming while a regime warms up and unavailable when none is published", () => {
    const list = conditionsFor(inputs({ regimes: [regimeFixture(300, { ready: false, trend: "Unknown", seenBars: 12, warmupBars: 28 })] }));

    expect(condition(list, "regime-5m").reading).toEqual({ kind: "warming", seen: 12, warmup: 28 });
    expect(condition(list, "regime-15m").reading).toEqual({ kind: "unavailable", reason: "not published" });
    const unknown = conditionsFor(inputs({ regimes: [regimeFixture(300, { ready: true, trend: "Unknown", seenBars: 30, warmupBars: 28 })] }));
    expect(condition(unknown, "regime-5m").reading.kind).toBe("warming");
  });

  it("should name the viewer's indicator timeframe in the indicator definitions", () => {
    const list = conditionsFor(inputs({ indicatorMinutes: 5, indicators: [] }));

    expect(condition(list, "ema-13-48").definition).toContain("closed 5-minute bars");
    expect(condition(list, "rsi-50").definition).toContain("closed 5-minute bars");
    expect(condition(list, "macd-signal").definition).toContain("closed 5-minute bars");
  });

  it("should show the inputs it compared as prices in the value", () => {
    const list = conditionsFor(inputs());

    expect(condition(list, "price-vwap").value).toBe("bid 5002.00 / ask 5002.25 · VWAP 5000.13");
    expect(condition(list, "ema-13-48").value).toMatch(/^EMA 13 5003\.00 · EMA 48 5001\.00 · closed /);
    expect(condition(list, "rsi-50").value).toMatch(/^RSI 61\.2 · closed /);
    expect(condition(list, "macd-signal").value).toMatch(/^MACD 0\.75 · signal 0\.25 · closed /);
    expect(condition(list, "price-poc").value).toBe("bid 5002.00 / ask 5002.25 · POC 5002.50");
    expect(condition(list, "price-value-area").value).toBe("bid 5002.00 / ask 5002.25 · VAL 4997.50 – VAH 5005.00");
    expect(condition(list, "regime-5m").value).toBe("ADX 18.5 · ER 0.20");
  });

  // — a state never sits beside two numbers that print the same.
  it("should print compared values with enough places to differ when the values differ but round to one price", () => {
    const list = conditionsFor(
      inputs({ indicators: [series("ema13", [20_004.01]), series("ema48", [20_004]), series("rsi14", [50.04]), series("macd", [3.004, 3, 0.004])] }),
    );

    const ema = condition(list, "ema-13-48");
    expect(readingText(ema.reading)).toBe("above");
    const [fast, slow] = /^EMA 13 (\S+) · EMA 48 (\S+) ·/.exec(ema.value)?.slice(1) ?? [];
    expect(fast).toBeDefined();
    expect(fast).not.toBe(slow);
    expect(slow).toBe("5001.000");

    const rsi = condition(list, "rsi-50");
    expect(readingText(rsi.reading)).toBe("above");
    expect(rsi.value).toMatch(/^RSI 50\.04 · closed /);

    const macd = condition(list, "macd-signal");
    expect(readingText(macd.reading)).toBe("above");
    const [line, signal] = /^MACD (\S+) · signal (\S+) ·/.exec(macd.value)?.slice(1) ?? [];
    expect(line).not.toBe(signal);
    expect(signal).toBe("0.750");
  });

  it("should print equal values at the instrument's own places when they are equal", () => {
    const list = conditionsFor(inputs({ indicators: [series("ema13", [20_004]), series("ema48", [20_004]), series("rsi14", [50])] }));

    expect(condition(list, "ema-13-48").value).toMatch(/^EMA 13 5001\.00 · EMA 48 5001\.00 ·/);
    expect(condition(list, "rsi-50").value).toMatch(/^RSI 50\.0 · /);
  });

  it("should carry no score, setup or suggested action in any wording", () => {
    const words = conditionsFor(inputs())
      .flatMap((item) => [item.name, item.definition, item.value, readingText(item.reading)])
      .join(" ")
      .toLowerCase();

    for (const banned of ["score", "setup", "buy", "sell", "long", "short", "bullish", "bearish", "pass", "fail", "signal to", "should"]) {
      expect(words, banned).not.toContain(banned);
    }
  });
});

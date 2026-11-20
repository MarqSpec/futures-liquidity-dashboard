import { describe, expect, it } from "vitest";

import { rawDelta, rawInstruments, rawSnapshot } from "../test/fixtures.ts";
import { deltaSchema, emptyMarketSummary, instrumentSummariesSchema, snapshotSchema, watchlistResultSchema } from "./schemas.ts";

describe("snapshotSchema", () => {
  it("should parse the captured snapshot when it is unchanged", () => {
    const result = snapshotSchema.safeParse(rawSnapshot);

    expect(result.success).toBe(true);
  });

  it("should keep the instrument's tick size when it parses the snapshot", () => {
    expect(snapshotSchema.parse(rawSnapshot).instrument.tickSize).toBe(0.25);
  });

  it("should ignore a field it does not know when the server adds one", () => {
    const extended = { ...(rawSnapshot as object), somethingNew: { nested: true } };

    expect(snapshotSchema.safeParse(extended).success).toBe(true);
  });

  it("should reject the snapshot when a heat column's flat array has a broken stride", () => {
    const snapshot = snapshotSchema.parse(rawSnapshot);
    const broken = { ...snapshot, heat: [{ t: 1, d: 1000, c: [1, 2, 3] }] };

    expect(snapshotSchema.safeParse(broken).success).toBe(false);
  });

  it("should read a named NaN literal as NaN when the API writes one for a double", () => {
    const snapshot = snapshotSchema.parse(rawSnapshot);
    const withNaN = { ...snapshot, vwap: { ...snapshot.vwap, stdDev: "NaN" } };

    expect(snapshotSchema.parse(withNaN).vwap.stdDev).toBeNaN();
  });
});

describe("deltaSchema", () => {
  it("should parse the captured delta when it is unchanged", () => {
    expect(deltaSchema.safeParse(rawDelta).success).toBe(true);
  });

  it("should reject the delta when its seq is missing", () => {
    const { seq: _seq, ...withoutSeq } = rawDelta as Record<string, unknown>;

    expect(deltaSchema.safeParse(withoutSeq).success).toBe(false);
  });

  it("should read an unknown bias as Neutral when a signal carries one", () => {
    const delta = deltaSchema.parse(rawDelta);
    const signal = { ...delta.orderFlow.signals[0], bias: "Sideways" };
    const changed = { ...delta, orderFlow: { ...delta.orderFlow, signals: [signal] } };

    expect(deltaSchema.parse(changed).orderFlow.signals[0]?.bias).toBe("Neutral");
  });
});

describe("instrumentSummariesSchema", () => {
  const snapshot = snapshotSchema.parse(rawSnapshot);
  const { sector: _sector, ...olderInstrument } = snapshot.instrument;
  const { depthSubscribed: _depth, ...olderStatus } = snapshot.status;

  it("should read an empty summary when an older server sends none", () => {
    const [row] = instrumentSummariesSchema.parse([{ instrument: snapshot.instrument, status: snapshot.status }]);

    expect(row?.summary).toEqual(emptyMarketSummary);
  });

  it("should file the product under Other and assume depth when an older server omits both", () => {
    const [row] = instrumentSummariesSchema.parse([{ instrument: olderInstrument, status: olderStatus }]);

    expect([row?.instrument.sector, row?.status.depthSubscribed]).toEqual(["Other", true]);
  });

  it("should read a summary's missing prices as null when nothing has traded", () => {
    const summary = { sessionVolume: 0, cumulativeDelta: 0, delta60s: 0, tradeRate: 0 };
    const [row] = instrumentSummariesSchema.parse([{ instrument: snapshot.instrument, status: snapshot.status, summary }]);

    expect([row?.summary.last, row?.summary.bid]).toEqual([null, null]);
  });

  it("should reject a row when a summary price is not a number", () => {
    const summary = { ...emptyMarketSummary, last: "6775" };

    expect(instrumentSummariesSchema.safeParse([{ instrument: snapshot.instrument, status: snapshot.status, summary }]).success).toBe(false);
  });
});

describe("marketSummarySchema regimes", () => {
  const rows = instrumentSummariesSchema.parse(rawInstruments);
  const gc = rows.find((r) => r.instrument.root === "GC");

  it("should parse the captured instruments when they carry regimes and signals", () => {
    expect(instrumentSummariesSchema.safeParse(rawInstruments).success).toBe(true);
  });

  it("should keep the newest signal with its bias when one fired", () => {
    expect(rows[0]?.summary.latestSignal?.kind).toBeTypeOf("string");
  });

  it("should read a trend it does not know as Unknown", () => {
    expect(gc?.summary.regimes.find((r) => r.timeframeSeconds === 900)?.trend).toBe("Unknown");
  });

  it("should leave out a regime entry of a kind it cannot read", () => {
    expect(gc?.summary.regimes.map((r) => r.timeframeSeconds)).toEqual([300, 900]);
  });

  it("should default the regimes, latest signal and 15-minute count when an older server omits them", () => {
    const { regimes: _r, latestSignal: _l, signals15m: _n, ...older } = emptyMarketSummary;
    const [row] = instrumentSummariesSchema.parse([{ instrument: rows[0]?.instrument, status: rows[0]?.status, summary: older }]);

    expect([row?.summary.regimes, row?.summary.latestSignal, row?.summary.signals15m]).toEqual([[], null, 0]);
  });

  it("should read a regime's missing ADX and EMAs as null when it is warming up", () => {
    const [row] = instrumentSummariesSchema.parse([
      { instrument: rows[0]?.instrument, status: rows[0]?.status, summary: { ...emptyMarketSummary, regimes: [{ timeframeSeconds: 300, trend: "Unknown" }] } },
    ]);

    expect(row?.summary.regimes[0]).toMatchObject({ ready: false, adx: null, emaFast: null, sinceMs: null });
  });

  it("should read the DI, the basis and the thresholds the server sends", () => {
    const thresholds = { trendAdx: 25, trendEfficiency: 0.3, rangeAdx: 20, rangeEfficiency: 0.2 };
    const [row] = instrumentSummariesSchema.parse([
      {
        instrument: rows[0]?.instrument,
        status: rows[0]?.status,
        summary: { ...emptyMarketSummary, regimes: [{ timeframeSeconds: 300, trend: "Ranging", plusDi: 12.5, minusDi: 20, basis: "RangeMet", thresholds }] },
      },
    ]);

    expect(row?.summary.regimes[0]).toMatchObject({ plusDi: 12.5, minusDi: 20, basis: "RangeMet", thresholds });
  });

  it("should read an older server's regime, with no basis or thresholds, as warmup and null", () => {
    const [row] = instrumentSummariesSchema.parse([
      { instrument: rows[0]?.instrument, status: rows[0]?.status, summary: { ...emptyMarketSummary, regimes: [{ timeframeSeconds: 300, trend: "Ranging" }] } },
    ]);

    expect(row?.summary.regimes[0]).toMatchObject({ plusDi: null, minusDi: null, basis: "Warmup", thresholds: null });
  });

  it("should read a basis this client does not list as Unknown, not as warmup", () => {
    const thresholds = { trendAdx: 25, trendEfficiency: 0.3, rangeAdx: 20, rangeEfficiency: 0.2 };
    const parse = (basis: unknown) =>
      instrumentSummariesSchema.parse([
        {
          instrument: rows[0]?.instrument,
          status: rows[0]?.status,
          summary: { ...emptyMarketSummary, regimes: [{ timeframeSeconds: 300, trend: "Ranging", ready: true, basis, thresholds }] },
        },
      ])[0]?.summary.regimes[0]?.basis;

    expect([parse("VolatilityMet"), parse(3), parse("rangeMet")]).toEqual(["Unknown", "Unknown", "Unknown"]);
    expect(parse("RangeMet")).toBe("RangeMet");
  });
});

describe("watchlistResultSchema", () => {
  it("should read the depth and refused roots when SetWatchlist answers", () => {
    expect(watchlistResultSchema.parse({ depth: ["ES"], refused: ["NG"] })).toEqual({ depth: ["ES"], refused: ["NG"] });
  });
});

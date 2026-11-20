import {
  deltaSchema,
  emptyMarketSummary,
  instrumentSummariesSchema,
  snapshotSchema,
  type Delta,
  type InstrumentInfo,
  type InstrumentSummary,
  type MarketSummary,
  type Regime,
  type Snapshot,
  type Status,
} from "../api/schemas.ts";
import deltaJson from "./fixtures/delta.json";
import instrumentsJson from "./fixtures/instruments.json";
import snapshotJson from "./fixtures/snapshot.json";

// Trimmed from a real ES capture of the API's synthetic feed (historyMinutes 5): one signal per kind, a few cells
// per heat slice (one partly unknown), two closed footprints and three points per indicator.

/** The raw snapshot fixture, as the wire carries it. */
export const rawSnapshot: unknown = snapshotJson;

/**
 * A synthetic GET /api/instruments answer: ES trending up on both timeframes with a recent signal, CL ranging on 5m
 * but trending down on 15m without depth, and GC still warming up, with a trend name and a regime entry this client
 * does not know.
 */
export const rawInstruments: unknown = instrumentsJson;

/** The instruments fixture, parsed. */
export function instrumentsFixture(): InstrumentSummary[] {
  return instrumentSummariesSchema.parse(rawInstruments);
}

/** A ready regime on `timeframeSeconds`, with fields overridden. */
export function regimeFixture(timeframeSeconds: number, overrides: Partial<Regime> = {}): Regime {
  return {
    timeframeSeconds,
    trend: "Ranging",
    ready: true,
    seenBars: 40,
    warmupBars: 28,
    adx: 18.5,
    plusDi: 20,
    minusDi: 18,
    efficiencyRatio: 0.2,
    emaFast: 27_000,
    emaSlow: 27_010,
    sinceMs: 1_794_114_000_000,
    basis: "RangeMet",
    thresholds: { trendAdx: 25, trendEfficiency: 0.3, rangeAdx: 20, rangeEfficiency: 0.2 },
    ...overrides,
  };
}

/** The raw delta fixture (a delta that closed a footprint bar), as the wire carries it. */
export const rawDelta: unknown = deltaJson;

/** The snapshot fixture, parsed. */
export function snapshotFixture(): Snapshot {
  return snapshotSchema.parse(rawSnapshot);
}

/** The delta fixture, parsed, with fields overridden. */
export function deltaFixture(overrides: Partial<Delta> = {}): Delta {
  return { ...deltaSchema.parse(rawDelta), ...overrides };
}

/** A delta that carries nothing new: only current state, as most 250 ms publications are. */
export function emptyDelta(seq: number, root = "ES"): Delta {
  const base = deltaFixture();
  return {
    ...base,
    root,
    seq,
    heat: [],
    bars: [],
    indicators: base.indicators.map((i) => ({ ...i, points: [] })),
    orderFlow: { ...base.orderFlow, footprints: [], cvdPoints: [], signals: [] },
  };
}

/** One product as GET /api/instruments lists it: the fixture's ES contract and status, renamed and re-filed. */
export function instrumentSummaryFixture(
  instrument: Partial<InstrumentInfo> = {},
  summary: Partial<MarketSummary> = {},
  status: Partial<Status> = {},
): InstrumentSummary {
  const snapshot = snapshotFixture();
  return {
    instrument: { ...snapshot.instrument, ...instrument },
    status: { ...snapshot.status, ...status },
    summary: { ...emptyMarketSummary, ...summary },
    nearestTouches: 0,
    nearestIsThirdTouch: false,
    levels: [],
  };
}

import type {
  Bar,
  Delta,
  Footprint,
  HeatColumn,
  Indicator,
  InstrumentInfo,
  Ladder,
  Liquidity,
  OrderFlow,
  Overlay,
  Profile,
  LevelTouch,
  Print,
  Signal,
  Snapshot,
  Status,
  Vwap,
} from "../api/schemas.ts";

/** An indicator as held: its closed points accumulate across deltas. */
export type IndicatorSeries = Omit<Indicator, "points"> & {
  readonly points: readonly (readonly (number | null)[])[];
};

/** The order-flow block as held: footprints, CVD points and signals accumulate; the rest is current state. */
export type MarketOrderFlow = Omit<OrderFlow, "footprints" | "cvdPoints" | "signals"> & {
  readonly footprints: readonly Footprint[];
  readonly cvdPoints: readonly (readonly [number, number])[];
  readonly signals: readonly Signal[];
};

/** A sampled point of the session VWAP: [timeMs, vwapTicks, stdDevTicks]. The wire carries only the current value. */
export type VwapPoint = readonly [number, number, number];

/** Everything the dashboard draws for one instrument, rebuilt from a snapshot and kept current by deltas. */
export interface MarketState {
  readonly root: string;
  readonly seq: number;
  readonly serverTimeMs: number;
  /** The client clock when the last message was applied, for ageing between publications. */
  readonly receivedAtMs: number;
  readonly historyMinutes: number;
  readonly instrument: InstrumentInfo;
  readonly status: Status;
  readonly heat: readonly HeatColumn[];
  readonly bars: readonly Bar[];
  readonly developingBar: Bar | null;
  readonly minuteBars: readonly Bar[];
  readonly developingMinute: Bar | null;
  readonly minuteHeat: readonly HeatColumn[];
  readonly developingMinuteHeat: HeatColumn | null;
  readonly levelTouches: readonly LevelTouch[];
  readonly prints: readonly Print[];
  /** Client clock when the newest print arrived. Null when the buffer is empty. Not on the wire. */
  readonly printArrivedAtMs: number | null;
  readonly indicators: readonly IndicatorSeries[];
  readonly profiles: readonly Profile[];
  readonly vwap: Vwap;
  readonly vwapTrail: readonly VwapPoint[];
  readonly liquidity: Liquidity;
  readonly ladder: Ladder;
  readonly overlay: Overlay | null;
  readonly sessionHigh: number | null;
  readonly sessionLow: number | null;
  readonly historyWatermarkMs: number | null;
  readonly orderFlow: MarketOrderFlow;
}

/**
 * Signals kept for one instrument inside the loaded history. The chart used to paint only the newest 40, and this
 * cap used to be 1 000, so events still inside the window disappeared. 20 000 matches the server cap
 * (`OrderFlow:SignalHistoryCap`, ARCHITECTURE.md D-41). A snapshot backfills every signal still inside the
 * requested history, including ones older than the old per-kind ring of 100.
 */
export const MAX_SIGNALS = 20_000;
export const MAX_CVD_POINTS = 2000;
export const MAX_INDICATOR_POINTS = 2000;
/** Matches the engine's default print cap (ARCHITECTURE.md D-34). */
export const MAX_PRINTS = 4096;
const VWAP_SAMPLE_MS = 1000;

/**
 * Appends the incoming items whose key is greater than the last existing key, so items already held (a delta can
 * repeat what the snapshot it follows included) are dropped and order is kept. Returns `existing` when nothing is new.
 */
export function appendNew<T>(existing: readonly T[], incoming: readonly T[], key: (item: T) => number): readonly T[] {
  if (incoming.length === 0) {
    return existing;
  }
  const last = existing.at(-1);
  const after = last === undefined ? Number.NEGATIVE_INFINITY : key(last);
  const fresh = incoming.filter((item) => key(item) > after);
  return fresh.length === 0 ? existing : [...existing, ...fresh];
}

/**
 * Inserts or replaces each incoming item by `t`, keeping time order. A repaired minute is older than the live
 * tail, so appending only newer keys would leave the empty bin on screen (D-33).
 */
export function upsertByTime<T extends { readonly t: number }>(existing: readonly T[], incoming: readonly T[]): readonly T[] {
  if (incoming.length === 0) {
    return existing;
  }
  const byTime = new Map<number, T>();
  for (const item of existing) {
    byTime.set(item.t, item);
  }
  let changed = false;
  for (const item of incoming) {
    const prior = byTime.get(item.t);
    if (prior === item) {
      continue;
    }
    byTime.set(item.t, item);
    changed = true;
  }
  if (!changed) {
    return existing;
  }
  return [...byTime.values()].sort((left, right) => left.t - right.t);
}

/** Drops leading items whose key is before `fromKey`; returns `items` when nothing is dropped. */
export function trimBefore<T>(items: readonly T[], fromKey: number, key: (item: T) => number): readonly T[] {
  const keep = items.findIndex((item) => key(item) >= fromKey);
  if (keep === 0) {
    return items;
  }
  return keep === -1 ? [] : items.slice(keep);
}

/** Keeps the last `max` items. */
export function capTail<T>(items: readonly T[], max: number): readonly T[] {
  return items.length > max ? items.slice(items.length - max) : items;
}

/** Drops signals older than the loaded history, then the oldest past `MAX_SIGNALS`. Nothing inside that bound is dropped. */
export function retainSignals(signals: readonly Signal[], fromMs: number): readonly Signal[] {
  let stale = false;
  for (const signal of signals) {
    if (signal.timeMs < fromMs) {
      stale = true;
      break;
    }
  }
  const inWindow = stale ? signals.filter((signal) => signal.timeMs >= fromMs) : signals;
  return capTail(inWindow, MAX_SIGNALS);
}

const byT = (item: { readonly t: number }) => item.t;
const byId = (item: { readonly id: number }) => item.id;
const byFirst = (item: readonly (number | null)[]) => item[0] ?? Number.NEGATIVE_INFINITY;

function windowStart(serverTimeMs: number, historyMinutes: number): number {
  return serverTimeMs - historyMinutes * 60_000;
}

function nextVwapTrail(trail: readonly VwapPoint[], previous: Vwap | null, vwap: Vwap, timeMs: number, fromMs: number) {
  const reset = previous !== null && previous.anchor !== vwap.anchor;
  const base = reset ? [] : trimBefore(trail, fromMs, (p) => p[0]);
  const value = vwap.vwap;
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return base;
  }
  const last = base.at(-1);
  if (last !== undefined && timeMs - last[0] < VWAP_SAMPLE_MS) {
    return base;
  }
  const sd = vwap.stdDev;
  return [...base, [timeMs, value, sd !== null && sd !== undefined && Number.isFinite(sd) ? sd : 0] as const];
}

/** Builds the state from a subscribe snapshot, keeping `historyMinutes` of heat, bars and footprints. */
export function fromSnapshot(snapshot: Snapshot, historyMinutes: number, receivedAtMs: number): MarketState {
  const fromMs = windowStart(snapshot.serverTimeMs, historyMinutes);
  return {
    root: snapshot.root,
    seq: snapshot.seq,
    serverTimeMs: snapshot.serverTimeMs,
    receivedAtMs,
    historyMinutes,
    instrument: snapshot.instrument,
    status: snapshot.status,
    heat: trimBefore(snapshot.heat, fromMs, byT),
    bars: trimBefore(snapshot.bars, fromMs, byT),
    developingBar: snapshot.developingBar ?? null,
    minuteBars: trimBefore(snapshot.minuteBars, fromMs, byT),
    developingMinute: snapshot.developingMinute ?? null,
    minuteHeat: trimBefore(snapshot.minuteHeat, fromMs, byT),
    developingMinuteHeat: snapshot.developingMinuteHeat ?? null,
    levelTouches: snapshot.levelTouches,
    prints: capTail(snapshot.prints, MAX_PRINTS),
    printArrivedAtMs: snapshot.prints.length > 0 ? receivedAtMs : null,
    indicators: snapshot.indicators.map((i) => ({ ...i, points: capTail(i.points, MAX_INDICATOR_POINTS) })),
    profiles: snapshot.profiles,
    vwap: snapshot.vwap,
    vwapTrail: nextVwapTrail([], null, snapshot.vwap, snapshot.serverTimeMs, fromMs),
    liquidity: snapshot.liquidity,
    ladder: snapshot.ladder,
    overlay: snapshot.overlay ?? null,
    sessionHigh: snapshot.sessionHigh ?? null,
    sessionLow: snapshot.sessionLow ?? null,
    historyWatermarkMs: snapshot.historyWatermarkMs ?? null,
    orderFlow: {
      ...snapshot.orderFlow,
      footprints: trimBefore(snapshot.orderFlow.footprints, fromMs, byT),
      cvdPoints: capTail(snapshot.orderFlow.cvdPoints, MAX_CVD_POINTS),
      signals: retainSignals(snapshot.orderFlow.signals, fromMs),
    },
  };
}

/** The same id is published once per viewer timeframe, so the key is the id and the timeframe together. */
function indicatorKey(series: { readonly id: string; readonly tf: number }): string {
  return `${series.id}:${series.tf}`;
}

function mergeIndicators(
  existing: readonly IndicatorSeries[],
  incoming: readonly Indicator[],
): readonly IndicatorSeries[] {
  if (incoming.length === 0) {
    return existing;
  }
  const byIdMap = new Map<string, IndicatorSeries>(existing.map((series) => [indicatorKey(series), series]));
  for (const next of incoming) {
    const current = byIdMap.get(indicatorKey(next));
    const points =
      current && current.tf === next.tf
        ? capTail(appendNew(current.points, next.points, byFirst), MAX_INDICATOR_POINTS)
        : capTail(next.points, MAX_INDICATOR_POINTS);
    byIdMap.set(indicatorKey(next), { ...next, points });
  }
  return [...byIdMap.values()];
}

/**
 * The series for the viewer's indicator timeframe. When that timeframe is not in the book yet (a switch whose
 * snapshot has not arrived, or a publication of a different timeframe), nothing is drawn: the previous series
 * are not a stand-in for the one the viewer just chose.
 */
export function indicatorsForViewer(indicators: readonly IndicatorSeries[], minutes: number): readonly IndicatorSeries[] {
  const tf = minutes * 60;
  return indicators.filter((series) => series.tf === tf);
}

/**
 * Applies the next delta (its seq must be state.seq + 1; the sequencer checks that). Newly closed heat slices, bars,
 * CVD points, indicator points and signals are appended without duplicates. Minute bars and footprints are
 * replaced when a repair fills an older minute. Everything else in the delta is current state.
 */
export function applyDelta(state: MarketState, delta: Delta, receivedAtMs: number): MarketState {
  const fromMs = windowStart(delta.serverTimeMs, state.historyMinutes);
  const flow = delta.orderFlow;
  const epochChanged = delta.status.epoch !== state.status.epoch;
  const prints = capTail(
    epochChanged ? (delta.prints ?? []) : appendNew(state.prints, delta.prints ?? [], (print) => print.sequence),
    MAX_PRINTS,
  );
  const newest = prints.at(-1)?.sequence;
  const previous = state.prints.at(-1)?.sequence;
  const printArrivedAtMs =
    newest === undefined ? null : epochChanged || newest !== previous ? receivedAtMs : state.printArrivedAtMs;
  return {
    ...state,
    seq: delta.seq,
    serverTimeMs: delta.serverTimeMs,
    receivedAtMs,
    status: delta.status,
    heat: trimBefore(appendNew(state.heat, delta.heat, byT), fromMs, byT),
    bars: trimBefore(appendNew(state.bars, delta.bars, byT), fromMs, byT),
    developingBar: delta.developingBar ?? null,
    minuteBars: trimBefore(upsertByTime(state.minuteBars, delta.minuteBars), fromMs, byT),
    developingMinute: delta.developingMinute ?? null,
    minuteHeat: trimBefore(appendNew(state.minuteHeat, delta.minuteHeat, byT), fromMs, byT),
    developingMinuteHeat: delta.developingMinuteHeat ?? null,
    levelTouches: delta.levelTouches,
    prints,
    printArrivedAtMs,
    indicators: mergeIndicators(state.indicators, delta.indicators),
    profiles: delta.profiles,
    vwap: delta.vwap,
    vwapTrail: nextVwapTrail(state.vwapTrail, state.vwap, delta.vwap, delta.serverTimeMs, fromMs),
    liquidity: delta.liquidity,
    ladder: delta.ladder,
    overlay: delta.overlay ?? null,
    sessionHigh: delta.sessionHigh ?? null,
    sessionLow: delta.sessionLow ?? null,
    orderFlow: {
      ...flow,
      footprints: trimBefore(upsertByTime(state.orderFlow.footprints, flow.footprints), fromMs, byT),
      cvdPoints: capTail(appendNew(state.orderFlow.cvdPoints, flow.cvdPoints, (p) => p[0]), MAX_CVD_POINTS),
      signals: retainSignals(appendNew(state.orderFlow.signals, flow.signals, byId), fromMs),
    },
  };
}

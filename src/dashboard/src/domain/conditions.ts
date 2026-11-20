import type { Liquidity, Profile, Regime, Vwap } from "../api/schemas.ts";
import { formatLocalMinute, formatTicks, type TickSpec } from "./format.ts";
import type { IndicatorSeries } from "./merge.ts";

// The Conditions panel (REQUIREMENTS.md FR-81, UC-21, ARCHITECTURE.md D-67): fixed-definition states read from values the
// server already sends. A state describes closed bars or the current book; nothing here scores, ranks or advises.

/** The fixed set of conditions, in the order the panel lists them. */
export const conditionIds = [
  "price-vwap",
  "ema-13-48",
  "rsi-50",
  "macd-signal",
  "price-poc",
  "price-value-area",
  "regime-5m",
  "regime-15m",
] as const;

export type ConditionId = (typeof conditionIds)[number];

/** A neutral statement about the inputs: where one value sits against another, or the server's regime. */
export type ConditionState = "above" | "below" | "at" | "inside" | "trending up" | "trending down" | "ranging" | "unclear";

/** What a condition reads now: a state, or why there is none. Only `state` is a state; the rest never read as one. */
export type ConditionReading =
  | { readonly kind: "state"; readonly state: ConditionState }
  | { readonly kind: "warming"; readonly seen: number; readonly warmup: number }
  | { readonly kind: "partial" }
  | { readonly kind: "stale" }
  | { readonly kind: "unavailable"; readonly reason: string };

/** One row of the panel: its fixed definition, the inputs it compared and what it reads. */
export interface Condition {
  readonly id: ConditionId;
  readonly name: string;
  readonly definition: string;
  readonly value: string;
  readonly reading: ConditionReading;
}

/** The top of the current book, from depth or, without depth, from quotes (REQUIREMENTS.md FR-54). */
export type ConditionBook = Pick<Liquidity, "bestBid" | "bestAsk" | "quoteStale">;

/** Everything the conditions read, all of it already on the wire. */
export interface ConditionInputs {
  /** The series for the viewer's indicator timeframe (`indicatorsForViewer`). */
  readonly indicators: readonly IndicatorSeries[];
  readonly indicatorMinutes: number;
  readonly vwap: Vwap;
  readonly book: ConditionBook;
  readonly profiles: readonly Profile[];
  /** The selected product's regimes from the polled summary (REQUIREMENTS.md FR-56). */
  readonly regimes: readonly Regime[];
  readonly spec: TickSpec;
}

/** A reading as the panel words it. */
export function readingText(reading: ConditionReading): string {
  switch (reading.kind) {
    case "state":
      return reading.state;
    case "warming":
      return `warming ${reading.seen}/${reading.warmup}`;
    case "partial":
      return "partial";
    case "stale":
      return "stale quote";
    case "unavailable":
      return reading.reason;
    default: {
      const unreachable: never = reading;
      return unreachable;
    }
  }
}

const state = (value: ConditionState): ConditionReading => ({ kind: "state", state: value });
const unavailable = (reason: string): ConditionReading => ({ kind: "unavailable", reason });

function finite(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

/** One value against another: above, below or at when equal. */
function compare(value: number, reference: number): ConditionReading {
  return state(value > reference ? "above" : value < reference ? "below" : "at");
}

/** The book against a level: above when the bid is over it, below when the ask is under it, at when the spread holds it. */
function bookAgainst(bid: number, ask: number, level: number): ConditionReading {
  return state(bid > level ? "above" : ask < level ? "below" : "at");
}

type Quote = { readonly bid: number; readonly ask: number } | ConditionReading;

function quoteOf(book: ConditionBook): Quote {
  if (!finite(book.bestBid) || !finite(book.bestAsk)) return unavailable("no quote");
  if (book.quoteStale) return { kind: "stale" };
  return { bid: book.bestBid, ask: book.bestAsk };
}

function isReading(quote: Quote): quote is ConditionReading {
  return "kind" in quote;
}

type Closed = { readonly values: readonly number[]; readonly timeMs: number } | ConditionReading;

/** The last closed values of a series at `indexes`; the developing value is never read. */
function lastClosed(series: IndicatorSeries | undefined, indexes: readonly number[]): Closed {
  if (!series) return unavailable("not published");
  if (!series.ready) return { kind: "warming", seen: series.seen, warmup: series.warmup };
  const point = series.points.at(-1);
  const timeMs = point?.[0];
  const values: number[] = [];
  for (const index of indexes) {
    const value = point?.[index];
    if (!finite(value)) return unavailable("no closed value");
    values.push(value);
  }
  if (!finite(timeMs)) return unavailable("no closed value");
  return { values, timeMs };
}

function isClosedReading(closed: Closed): closed is ConditionReading {
  return "kind" in closed;
}

function priceText(spec: TickSpec, quote: Quote): string {
  return isReading(quote) ? "bid — / ask —" : `bid ${formatTicks(quote.bid, spec)} / ask ${formatTicks(quote.ask, spec)}`;
}

function closedText(timeMs: number): string {
  return `closed ${formatLocalMinute(timeMs)}`;
}

/** Extra places allowed so two unequal compared values never print the same. */
const MAX_EXTRA_PLACES = 6;

// — "above" must never sit beside two numbers that print the same
/** Two compared values at the fewest places, from `places` up, at which unequal values print unequal; equal values keep `places`. */
function apart(a: number, b: number, places: number): readonly [string, string] {
  for (let d = places; ; d += 1) {
    const x = a.toFixed(d);
    const y = b.toFixed(d);
    if (a === b || x !== y || d >= places + MAX_EXTRA_PLACES) return [x, y];
  }
}

function digits(value: number | null, places: number): string {
  return finite(value) ? value.toFixed(places) : "—";
}

function priceVwap(inputs: ConditionInputs, quote: Quote): Condition {
  const level = inputs.vwap.vwap;
  const reading: ConditionReading = !finite(level)
    ? unavailable("no VWAP yet")
    : isReading(quote)
      ? quote
      : inputs.vwap.partial
        ? { kind: "partial" }
        : bookAgainst(quote.bid, quote.ask, level);
  return {
    id: "price-vwap",
    name: "Price vs VWAP",
    definition:
      "The current book against the session VWAP: above when the best bid is over it, below when the best ask is under it, at when it lies within the spread.",
    value: `${priceText(inputs.spec, quote)} · VWAP ${formatTicks(level, inputs.spec)}`,
    reading,
  };
}

function emaCross(inputs: ConditionInputs, bars: string): Condition {
  const fast = lastClosed(inputs.indicators.find((s) => s.id === "ema13"), [1]);
  const slow = lastClosed(inputs.indicators.find((s) => s.id === "ema48"), [1]);
  // The slower series warms up last, so its counts are the ones still to go.
  const reading = isClosedReading(slow) ? slow : isClosedReading(fast) ? fast : compare(fast.values[0] ?? 0, slow.values[0] ?? 0);
  let value = "EMA 13 — · EMA 48 —";
  if (!isClosedReading(fast) && !isClosedReading(slow)) {
    const [a, b] = apart((fast.values[0] ?? 0) * inputs.spec.tickSize, (slow.values[0] ?? 0) * inputs.spec.tickSize, inputs.spec.priceDecimals);
    value = `EMA 13 ${a} · EMA 48 ${b} · ${closedText(slow.timeMs)}`;
  }
  return {
    id: "ema-13-48",
    name: "EMA 13 vs EMA 48",
    definition: `On closed ${bars} bars: above when EMA 13 is over EMA 48, below when it is under, at when they are equal. The forming bar is not used.`,
    value,
    reading,
  };
}

function rsi50(inputs: ConditionInputs, bars: string): Condition {
  const rsi = lastClosed(inputs.indicators.find((s) => s.id === "rsi14"), [1]);
  return {
    id: "rsi-50",
    name: "RSI 14 vs 50",
    definition: `On closed ${bars} bars: above when RSI 14 is over 50, below when it is under, at when it is 50. The forming bar is not used.`,
    value: isClosedReading(rsi) ? "RSI —" : `RSI ${apart(rsi.values[0] ?? 0, 50, 1)[0]} · ${closedText(rsi.timeMs)}`,
    reading: isClosedReading(rsi) ? rsi : compare(rsi.values[0] ?? 0, 50),
  };
}

function macdSignal(inputs: ConditionInputs, bars: string): Condition {
  const macd = lastClosed(inputs.indicators.find((s) => s.id === "macd"), [1, 2]);
  const shown = isClosedReading(macd)
    ? null
    : apart((macd.values[0] ?? 0) * inputs.spec.tickSize, (macd.values[1] ?? 0) * inputs.spec.tickSize, inputs.spec.priceDecimals);
  return {
    id: "macd-signal",
    name: "MACD vs its signal line",
    definition: `On closed ${bars} bars: above when the MACD line (12/26) is over its 9-period signal line, below when it is under, at when they are equal. The forming bar is not used.`,
    value: isClosedReading(macd) || shown === null ? "MACD — · signal —" : `MACD ${shown[0]} · signal ${shown[1]} · ${closedText(macd.timeMs)}`,
    reading: isClosedReading(macd) ? macd : compare(macd.values[0] ?? 0, macd.values[1] ?? 0),
  };
}

/** A level of the session profile against the book: unavailable without the level, then the quote's reason, then partial. */
function profileReading(
  profile: Profile | undefined,
  levels: readonly (number | null | undefined)[],
  quote: Quote,
  compute: (bid: number, ask: number) => ConditionReading,
): ConditionReading {
  if (!profile || !levels.every(finite)) return unavailable("no session profile");
  if (isReading(quote)) return quote;
  if (finite(profile.partialSinceMs)) return { kind: "partial" };
  return compute(quote.bid, quote.ask);
}

function pricePoc(inputs: ConditionInputs, profile: Profile | undefined, quote: Quote): Condition {
  const poc = profile?.poc ?? null;
  return {
    id: "price-poc",
    name: "Price vs POC",
    definition:
      "The current book against the session profile's point of control: above when the best bid is over it, below when the best ask is under it, at when it lies within the spread.",
    value: `${priceText(inputs.spec, quote)} · POC ${formatTicks(poc, inputs.spec)}`,
    reading: profileReading(profile, [poc], quote, (bid, ask) => bookAgainst(bid, ask, poc ?? 0)),
  };
}

function valueArea(bid: number, ask: number, val: number, vah: number): ConditionReading {
  if (bid > vah) return state("above");
  if (ask < val) return state("below");
  if (bid >= val && ask <= vah) return state("inside");
  return state("at");
}

function priceValueArea(inputs: ConditionInputs, profile: Profile | undefined, quote: Quote): Condition {
  const val = profile?.val ?? null;
  const vah = profile?.vah ?? null;
  return {
    id: "price-value-area",
    name: "Price vs value area",
    definition:
      "The current book against the session profile's 70% value area: above when the best bid is over VAH, below when the best ask is under VAL, inside when bid and ask are both within VAL–VAH, at when the spread straddles an edge.",
    value: `${priceText(inputs.spec, quote)} · VAL ${formatTicks(val, inputs.spec)} – VAH ${formatTicks(vah, inputs.spec)}`,
    reading: profileReading(profile, [val, vah], quote, (bid, ask) => valueArea(bid, ask, val ?? 0, vah ?? 0)),
  };
}

function regimeReading(regime: Regime | null): ConditionReading {
  if (regime === null) return unavailable("not published");
  if (!regime.ready || regime.trend === "Unknown") return { kind: "warming", seen: regime.seenBars, warmup: regime.warmupBars };
  switch (regime.trend) {
    case "TrendingUp":
      return state("trending up");
    case "TrendingDown":
      return state("trending down");
    case "Ranging":
      return state("ranging");
    case "Transition":
      return state("unclear");
    default: {
      const unreachable: never = regime.trend;
      return unreachable;
    }
  }
}

function regimeCondition(inputs: ConditionInputs, id: "regime-5m" | "regime-15m", minutes: number): Condition {
  const regime = inputs.regimes.find((item) => item.timeframeSeconds === minutes * 60) ?? null;
  return {
    id,
    name: `${minutes}m regime`,
    definition: `The server's regime on closed ${minutes}-minute bars, by its stated rule (ADX, the efficiency ratio and EMA 13 against EMA 48): trending up, trending down, ranging or unclear.`,
    value: regime === null ? "ADX — · ER —" : `ADX ${digits(regime.adx, 1)} · ER ${digits(regime.efficiencyRatio, 2)}`,
    reading: regimeReading(regime),
  };
}

/** The fixed conditions, in `conditionIds` order, from values the server already sends. */
export function conditionsFor(inputs: ConditionInputs): readonly Condition[] {
  const quote = quoteOf(inputs.book);
  const bars = `${inputs.indicatorMinutes}-minute`;
  const session = inputs.profiles.find((profile) => profile.window === "session");
  return [
    priceVwap(inputs, quote),
    emaCross(inputs, bars),
    rsi50(inputs, bars),
    macdSignal(inputs, bars),
    pricePoc(inputs, session, quote),
    priceValueArea(inputs, session, quote),
    regimeCondition(inputs, "regime-5m", 5),
    regimeCondition(inputs, "regime-15m", 15),
  ];
}

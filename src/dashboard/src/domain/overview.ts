import type { InstrumentInfo, InstrumentSummary, MarketSummary, Regime, Signal } from "../api/schemas.ts";
import { formatAge, formatSigned, formatTicks, type TickSpec } from "./format.ts";
import { changeTicks, matchesFilter } from "./products.ts";
import { regimeAgreement, regimeFor, regimeRank, regimeTimeframes, type Agreement } from "./regime.ts";

/** The columns the Overview sorts by. */
export const overviewSortKeys = [
  "product",
  "last",
  "change",
  "range",
  "volume",
  "spread",
  "tradeRate",
  "delta60s",
  "cvd",
  "regime5m",
  "regime15m",
  "agreement",
  "signal",
  "health",
] as const;
export type OverviewSortKey = (typeof overviewSortKeys)[number];

/** The Overview's sort: a column and a direction, or none (the products grouped as the picker groups them). */
export type OverviewSort = { readonly key: OverviewSortKey; readonly direction: "ascending" | "descending" } | null;

/** One product's Overview row: what the cells show, read straight from its summary. */
export interface OverviewRow {
  readonly instrument: InstrumentInfo;
  readonly source: InstrumentSummary;
  readonly regime5m: Regime | null;
  readonly regime15m: Regime | null;
  readonly agreement: Agreement;
  readonly latestSignal: Signal | null;
}

/** The Overview row of one product. */
export function overviewRow(source: InstrumentSummary): OverviewRow {
  const [fast, slow] = regimeTimeframes;
  const regime5m = regimeFor(source.summary, fast);
  const regime15m = regimeFor(source.summary, slow);
  return {
    instrument: source.instrument,
    source,
    regime5m,
    regime15m,
    agreement: regimeAgreement(regime5m, regime15m),
    latestSignal: source.summary.latestSignal,
  };
}

const agreementRank: Readonly<Record<Agreement, number>> = { agree: 0, conflict: 1, mixed: 2 };
const healthRank: Readonly<Record<string, number>> = { LIVE: 0, REPLAY: 1, SIMULATED: 2, DEGRADED: 3, RECOVERING: 4, STALE: 5 };

/** The session range as a fraction of the opening price, so products of every price level compare. */
function rangeFraction(row: OverviewRow): number | null {
  const { sessionHigh, sessionLow, sessionOpen } = row.source.summary;
  return sessionHigh === null || sessionLow === null || sessionOpen === null || sessionOpen <= 0
    ? null
    : (sessionHigh - sessionLow) / sessionOpen;
}

/** The value a column sorts by; null sorts last whichever the direction. */
export function sortValue(row: OverviewRow, key: OverviewSortKey): number | string | null {
  const s = row.source.summary;
  switch (key) {
    case "product":
      return row.instrument.root;
    case "last":
      return s.last;
    case "change": {
      // As a fraction of the open, so a 6000-point index and a 1.1 currency compare.
      const change = changeTicks(s);
      return change === null || s.sessionOpen === null || s.sessionOpen <= 0 ? null : change / s.sessionOpen;
    }
    case "range":
      return rangeFraction(row);
    case "volume":
      return s.sessionVolume;
    case "spread":
      return s.bid === null || s.ask === null || s.ask < s.bid ? null : s.ask - s.bid;
    case "tradeRate":
      return s.tradeRate;
    case "delta60s":
      return s.delta60s;
    case "cvd":
      return s.cumulativeDelta;
    case "regime5m":
      return regimeRank(row.regime5m);
    case "regime15m":
      return regimeRank(row.regime15m);
    case "agreement":
      return agreementRank[row.agreement];
    case "signal":
      return row.latestSignal?.timeMs ?? null;
    case "health":
      return healthRank[row.source.status.code] ?? Object.keys(healthRank).length;
    default: {
      const unreachable: never = key;
      return unreachable;
    }
  }
}

function missing(value: number | string | null): value is null {
  return value === null || (typeof value === "number" && Number.isNaN(value));
}

function compare(a: number | string, b: number | string): number {
  return typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
}

/** The rows sorted by one column, ties broken by root; a missing value is last in either direction. */
export function sortOverview(rows: readonly OverviewRow[], key: OverviewSortKey, direction: "ascending" | "descending"): OverviewRow[] {
  const sign = direction === "ascending" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = sortValue(a, key);
    const y = sortValue(b, key);
    const order = missing(x) || missing(y) ? Number(missing(x)) - Number(missing(y)) : compare(x, y) * sign;
    return order || a.instrument.root.localeCompare(b.instrument.root);
  });
}

/** The sort a header click leads to: a new column sorts ascending, then descending, then back to grouped. */
export function nextSort(current: OverviewSort, key: OverviewSortKey): OverviewSort {
  if (current?.key !== key) return { key, direction: "ascending" };
  return current.direction === "ascending" ? { key, direction: "descending" } : null;
}

/** The products matching `filter`, as Overview rows sorted by `key`. */
export function sortedOverview(
  summaries: readonly InstrumentSummary[],
  filter: string,
  key: OverviewSortKey,
  direction: "ascending" | "descending",
): OverviewRow[] {
  return sortOverview(
    summaries.filter((s) => matchesFilter(s.instrument, filter)).map(overviewRow),
    key,
    direction,
  );
}

/** A signed quantity with the arrow of its direction: "↑ +1,200", "↓ −300", "→ 0". */
export function formatArrowed(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const arrow = value > 0 ? "↑" : value < 0 ? "↓" : "→";
  return `${arrow} ${formatSigned(value)}`;
}

/** Contracts traded per second over the last 10 s (REQUIREMENTS.md FR-39), as "3.4/s". */
export function formatRate(rate: number): string {
  return Number.isFinite(rate) ? `${rate.toFixed(1)}/s` : "—";
}

/** The session's high and low as "high / low"; "—" until something has traded. */
export function formatHighLow(summary: MarketSummary, spec: TickSpec): string {
  return summary.sessionHigh === null || summary.sessionLow === null
    ? "—"
    : `${formatTicks(summary.sessionHigh, spec)} / ${formatTicks(summary.sessionLow, spec)}`;
}

/** How long ago a signal fired, to the minute: "<1 min", "4 min", "1.5 h". */
export function formatSignalAge(ageMs: number): string {
  return ageMs < 60_000 ? "<1 min" : formatAge(ageMs);
}

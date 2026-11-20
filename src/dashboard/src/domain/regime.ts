import type { MarketSummary, Regime } from "../api/schemas.ts";
import { formatLocalMinute, formatTicks, type TickSpec } from "./format.ts";

/** The two bar timeframes the dashboard shows a regime for, in seconds. */
export const regimeTimeframes = [300, 900] as const;

/** A regime cell's colour. */
export type RegimeTone = "up" | "down" | "range" | "unclear" | "warming" | "none";

/** How the 5- and 15-minute regimes relate: the same, opposed, or not both readable. */
export type Agreement = "agree" | "conflict" | "mixed";

/** A timeframe in seconds as "5m", "15m" or "1h". */
export function timeframeLabel(seconds: number): string {
  return seconds % 3600 === 0 ? `${seconds / 3600}h` : seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
}

/** The regime on `timeframeSeconds`, or null when the server publishes none for it. */
export function regimeFor(summary: MarketSummary, timeframeSeconds: number): Regime | null {
  return summary.regimes.find((r) => r.timeframeSeconds === timeframeSeconds) ?? null;
}

function warming(regime: Regime | null): boolean {
  return regime !== null && (!regime.ready || regime.trend === "Unknown");
}

/** A regime's short label: "Trend ↑", "Trend ↓", "Range", "Unclear", "Warming n/m"; "—" when there is none. */
export function regimeLabel(regime: Regime | null): string {
  if (regime === null) return "—";
  if (warming(regime)) return `Warming ${regime.seenBars}/${regime.warmupBars}`;
  switch (regime.trend) {
    case "TrendingUp":
      return "Trend ↑";
    case "TrendingDown":
      return "Trend ↓";
    case "Ranging":
      return "Range";
    case "Transition":
      return "Unclear";
    case "Unknown":
      return `Warming ${regime.seenBars}/${regime.warmupBars}`;
    default: {
      const unreachable: never = regime.trend;
      return unreachable;
    }
  }
}

/** A regime's colour. */
export function regimeTone(regime: Regime | null): RegimeTone {
  if (regime === null) return "none";
  if (warming(regime)) return "warming";
  switch (regime.trend) {
    case "TrendingUp":
      return "up";
    case "TrendingDown":
      return "down";
    case "Ranging":
      return "range";
    case "Transition":
      return "unclear";
    case "Unknown":
      return "warming";
    default: {
      const unreachable: never = regime.trend;
      return unreachable;
    }
  }
}

function num(value: number | null, digits: number): string {
  return value === null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

/** The regime's tooltip: its inputs and since when it has held. */
export function regimeTitle(regime: Regime | null, spec: TickSpec): string {
  if (regime === null) return "No regime published for this timeframe";
  const since = regime.sinceMs === null ? "—" : formatLocalMinute(regime.sinceMs);
  return [
    `${timeframeLabel(regime.timeframeSeconds)} ${regimeLabel(regime)}`,
    `ADX ${num(regime.adx, 1)}`,
    `ER ${num(regime.efficiencyRatio, 2)}`,
    `EMA fast ${formatTicks(regime.emaFast, spec)} / slow ${formatTicks(regime.emaSlow, spec)}`,
    `since ${since}`,
  ].join(" · ");
}

/** A threshold exactly as the server sent it, so the sentence names the limit the rule compared against. */
function limit(value: number): string {
  return String(value);
}

/**
 * Why a regime reads as it does, as lines of text for the badge's hint: the verdict, the test that decided it (the
 * server's `basis`) beside the thresholds it was judged against, and every input. Nothing here classifies: the
 * server names the test, and these lines only print its numbers (REQUIREMENTS.md FR-56, UC-19).
 */
export function regimeExplanation(regime: Regime | null, spec: TickSpec): string[] {
  if (regime === null) return ["No regime published for this timeframe"];
  const head = `${timeframeLabel(regime.timeframeSeconds)} ${regimeLabel(regime)}`;
  // The server's own precision (RegimeTracker.State): fewer places could print a value just under a limit as the limit.
  const adx = num(regime.adx, 2);
  const er = num(regime.efficiencyRatio, 3);
  const plusDi = num(regime.plusDi, 2);
  const minusDi = num(regime.minusDi, 2);
  const t = regime.thresholds;
  let why: string;
  if (regime.basis === "Warmup" && t === null) {
    why = "Limits not published by this server.";
  } else {
    switch (regime.basis) {
      case "Warmup":
        why = `Warming up: ${regime.seenBars} of ${regime.warmupBars} closed bars are in.`;
        break;
      case "TrendMet": {
        const up = regime.trend === "TrendingUp";
        const di = up
          ? `+DI ${plusDi} is over -DI ${minusDi}`
          : `-DI ${minusDi} is over +DI ${plusDi}`;
        why = t
          ? `Trending ${up ? "up" : "down"}: ADX ${adx} is at or over ${limit(t.trendAdx)} and the efficiency ratio ${er} is at or over ${limit(t.trendEfficiency)}; ${di}.`
          : `Trending ${up ? "up" : "down"}: ${di}.`;
        break;
      }
      case "DirectionDisagrees":
        why = t
          ? `Unclear: ADX ${adx} and the efficiency ratio ${er} meet the trend limits (${limit(t.trendAdx)}, ${limit(t.trendEfficiency)}), but +DI/-DI and the EMAs do not point the same way.`
          : "Unclear: +DI/-DI and the EMAs do not point the same way.";
        break;
      case "RangeMet":
        why = t
          ? `Range: ADX ${adx} is at or under ${limit(t.rangeAdx)} and the efficiency ratio ${er} is at or under ${limit(t.rangeEfficiency)}.`
          : "Range: ADX and the efficiency ratio are both low.";
        break;
      case "Between":
        why = t
          ? `Unclear: ADX ${adx} and the efficiency ratio ${er} are not both over the trend limits (${limit(t.trendAdx)}, ${limit(t.trendEfficiency)}) and not both under the range limits (${limit(t.rangeAdx)}, ${limit(t.rangeEfficiency)}).`
          : "Unclear: between the trend and range limits.";
        break;
      case "Unknown":
        why = "The server named a test this dashboard does not read; its inputs are below.";
        break;
      default: {
        const unreachable: never = regime.basis;
        return unreachable;
      }
    }
  }
  const since = regime.sinceMs === null ? "—" : formatLocalMinute(regime.sinceMs);
  return [
    head,
    why,
    `ADX ${adx} · efficiency ratio ${er} · +DI ${plusDi} · -DI ${minusDi} · EMA fast ${formatTicks(regime.emaFast, spec)} / slow ${formatTicks(regime.emaSlow, spec)}`,
    `since ${since}`,
  ];
}

type Direction = "up" | "down" | "range";

function readable(regime: Regime | null): Direction | null {
  if (regime === null || warming(regime)) return null;
  switch (regime.trend) {
    case "TrendingUp":
      return "up";
    case "TrendingDown":
      return "down";
    case "Ranging":
      return "range";
    case "Transition":
    case "Unknown":
      return null;
    default: {
      const unreachable: never = regime.trend;
      return unreachable;
    }
  }
}

/**
 * Whether two timeframes' regimes agree: both trending the same way or both ranging agree; one trending up and the
 * other down, or one trending and the other ranging, conflict; either one unclear, warming or missing is mixed.
 */
export function regimeAgreement(a: Regime | null, b: Regime | null): Agreement {
  const x = readable(a);
  const y = readable(b);
  if (x === null || y === null) return "mixed";
  return x === y ? "agree" : "conflict";
}

/** An order for sorting by regime: up, down, range, unclear, warming, none. */
export function regimeRank(regime: Regime | null): number {
  const order: readonly RegimeTone[] = ["up", "down", "range", "unclear", "warming", "none"];
  return order.indexOf(regimeTone(regime));
}

import type { InstrumentSummary, LevelTouch } from "../api/schemas.ts";
import { formatTicks } from "./format.ts";

/** One chip of the touch lane: a product and one of its touched levels. */
export interface RecentTouch {
  readonly root: string;
  readonly level: LevelTouch;
}

/**
 * Touched levels across the quoted products, in a stated order (REQUIREMENTS.md FR-79): starred products first, then the
 * most recent touch, then root, level name and price, so equal touch times never reshuffle between refreshes.
 */
export function recentTouches(quotes: readonly InstrumentSummary[], starred: readonly string[], limit = 8): RecentTouch[] {
  const star = new Set(starred);
  return quotes
    .flatMap((quote) =>
      quote.levels
        .filter((level) => level.lastTouchMs != null)
        .map((level) => ({ root: quote.instrument.root, level })),
    )
    .sort(
      (a, b) =>
        Number(star.has(b.root)) - Number(star.has(a.root)) ||
        (b.level.lastTouchMs ?? 0) - (a.level.lastTouchMs ?? 0) ||
        byText(a.root, b.root) ||
        byText(a.level.name, b.level.name) ||
        b.level.priceTicks - a.level.priceTicks,
    )
    .slice(0, limit);
}

// Code-unit order, not the locale's, so every browser draws the same lane.
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A level's touch count and how those touches ended (REQUIREMENTS.md FR-79): held, or broke by a close two ticks beyond. */
export function touchOutcomeText(level: Pick<LevelTouch, "touches" | "isThirdTouch" | "held" | "broke">): string {
  if (level.touches === 0) {
    return "no touch yet";
  }
  const count = level.isThirdTouch ? "3rd touch" : `${level.touches} touch${level.touches === 1 ? "" : "es"}`;
  return `${count} · ${level.held} held · ${level.broke} broke`;
}

/** Signed distance from the last price to VWAP, in ticks. */
export function vwapPosition(lastTicks: number | null | undefined, vwapTicks: number | null | undefined): string {
  if (lastTicks == null || vwapTicks == null || !Number.isFinite(vwapTicks)) {
    return "VWAP —";
  }
  const delta = Math.round(lastTicks - vwapTicks);
  if (delta === 0) {
    return "at VWAP";
  }
  return delta > 0 ? `VWAP +${delta}t` : `VWAP ${delta}t`;
}

/** Session change in price units, from the open. */
export function sessionChange(
  changeTicks: number | null | undefined,
  tickSize: number,
  decimals: number,
): string {
  if (changeTicks == null) {
    return "—";
  }
  const value = changeTicks * tickSize;
  const text = Math.abs(value).toFixed(decimals);
  if (value > 0) return `+${text}`;
  if (value < 0) return `−${text}`;
  return text;
}

/** The nearest-level line on a tab, with the third touch called out and, when the quote lists it, its outcome. */
export function nearestLevelText(quote: Pick<InstrumentSummary, "nearestLevel" | "nearestTouches" | "nearestIsThirdTouch" | "instrument"> & {
  nearestDistanceTicks?: number | null;
  lastTicks?: number | null;
  levels?: readonly LevelTouch[];
}): string {
  if (!quote.nearestLevel) {
    return "no level yet";
  }
  const at = quote.lastTicks != null && quote.nearestDistanceTicks != null ? quote.lastTicks - quote.nearestDistanceTicks : null;
  const level = quote.levels?.find((candidate) => candidate.name === quote.nearestLevel && candidate.priceTicks === at);
  if (level && level.touches > 0) {
    return `${quote.nearestLevel} · ${touchOutcomeText(level)}`;
  }
  const touch = quote.nearestIsThirdTouch ? "3rd touch" : `${quote.nearestTouches} touch${quote.nearestTouches === 1 ? "" : "es"}`;
  return `${quote.nearestLevel} · ${touch}`;
}

/** Last price, or an em dash before the first trade. */
export function lastPriceText(
  lastTicks: number | null | undefined,
  spec: { readonly tickSize: number; readonly priceDecimals: number },
): string {
  return lastTicks == null ? "—" : formatTicks(lastTicks, spec);
}

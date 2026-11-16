import type { InstrumentSummary } from "../api/schemas.ts";
import { formatTicks } from "./format.ts";

/** Recent level approaches across the quoted instruments, newest first. */
export function recentTouches(quotes: readonly InstrumentSummary[], limit = 8) {
  return quotes
    .flatMap((quote) =>
      quote.levels
        .filter((level) => level.lastTouchMs != null)
        .map((level) => ({ root: quote.instrument.root, level })),
    )
    .sort((a, b) => (b.level.lastTouchMs ?? 0) - (a.level.lastTouchMs ?? 0))
    .slice(0, limit);
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

/** The nearest-level line on a tab, with the third touch called out. */
export function nearestLevelText(quote: Pick<InstrumentSummary, "nearestLevel" | "nearestTouches" | "nearestIsThirdTouch" | "instrument"> & {
  nearestDistanceTicks?: number | null;
}): string {
  if (!quote.nearestLevel) {
    return "no level yet";
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

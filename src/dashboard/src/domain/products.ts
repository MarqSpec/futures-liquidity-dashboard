import type { InstrumentSummary } from "../api/schemas.ts";
import { formatQty, formatSigned, formatTicks, ticksToPrice, type TickSpec } from "./format.ts";
import { chipTone } from "./status.ts";

/** Which way a number moved, for its colour. */
export type Direction = "up" | "down" | "flat" | "none";

/** One product as the picker shows it: every cell already formatted. */
export interface ProductRow {
  readonly root: string;
  readonly name: string;
  readonly sector: string;
  readonly last: string;
  readonly change: string;
  readonly changePercent: string;
  readonly changeDirection: Direction;
  readonly spread: string;
  readonly volume: string;
  readonly cvd: string;
  readonly cvdDirection: Direction;
  readonly code: string;
  readonly tone: ReturnType<typeof chipTone>;
  readonly depth: boolean;
}

/** A titled run of rows: the watchlist, or one sector. */
export interface ProductGroup {
  readonly title: string;
  readonly rows: readonly ProductRow[];
}

/** The title of the group that holds the watched products. */
export const watchlistTitle = "Watchlist";

/** The order sectors are listed in; a sector the server adds later follows these, alphabetically. */
export const sectorOrder: readonly string[] = [
  "Equity index",
  "Energy",
  "Metals",
  "Interest rates",
  "Currencies",
  "Agriculture",
  "Crypto",
  "Other",
];

function direction(value: number | null): Direction {
  if (value === null || !Number.isFinite(value)) return "none";
  return value > 0 ? "up" : value < 0 ? "down" : "flat";
}

function signOf(value: number): string {
  return value > 0 ? "+" : value < 0 ? "−" : "";
}

/** The change from the session's opening price in ticks; null until both are known. */
export function changeTicks(summary: InstrumentSummary["summary"]): number | null {
  return summary.last === null || summary.sessionOpen === null ? null : summary.last - summary.sessionOpen;
}

/** A tick change as a signed price: "+1.25", "−0.30", "0.00"; "—" when unknown. */
export function formatPriceChange(ticks: number | null, spec: TickSpec): string {
  if (ticks === null || !Number.isFinite(ticks)) return "—";
  return `${signOf(ticks)}${ticksToPrice(Math.abs(ticks), spec).toFixed(spec.priceDecimals)}`;
}

/** A tick change as a signed percentage of the opening price: "+0.12 %"; "—" when it cannot be told. */
export function formatPercentChange(ticks: number | null, openTicks: number | null): string {
  if (ticks === null || openTicks === null || openTicks <= 0 || !Number.isFinite(ticks)) return "—";
  const percent = (100 * ticks) / openTicks;
  const rounded = Math.abs(percent).toFixed(2);
  return `${Number(rounded) === 0 ? "" : signOf(percent)}${rounded} %`;
}

/** The inside spread in ticks; "—" while either side is unknown or the sides are crossed. */
export function formatSpread(summary: InstrumentSummary["summary"]): string {
  if (summary.bid === null || summary.ask === null || summary.ask < summary.bid) return "—";
  return String(summary.ask - summary.bid);
}

/** One product's row, formatted with its own tick size and decimals (the API's prices are integer ticks). */
export function productRow({ instrument, status, summary }: InstrumentSummary): ProductRow {
  const change = changeTicks(summary);
  return {
    root: instrument.root,
    name: instrument.name,
    sector: instrument.sector,
    last: formatTicks(summary.last, instrument),
    change: formatPriceChange(change, instrument),
    changePercent: formatPercentChange(change, summary.sessionOpen),
    changeDirection: direction(change),
    spread: formatSpread(summary),
    volume: formatQty(summary.sessionVolume),
    cvd: status.cvdKnown ? formatSigned(summary.cumulativeDelta) : "unknown",
    cvdDirection: status.cvdKnown ? direction(summary.cumulativeDelta) : "none",
    code: status.code,
    tone: chipTone(status.code),
    depth: status.depthSubscribed,
  };
}

/** Whether a product matches the filter text: a root or name containing it, ignoring case; blank matches all. */
export function matchesFilter(product: { readonly root: string; readonly name: string }, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  return needle === "" || product.root.toLowerCase().includes(needle) || product.name.toLowerCase().includes(needle);
}

function sectorRank(sector: string): number {
  const index = sectorOrder.indexOf(sector);
  return index === -1 ? sectorOrder.length : index;
}

/** A titled run of products: the watchlist, or one sector. */
export interface SummaryGroup {
  readonly title: string;
  readonly items: readonly InstrumentSummary[];
}

/**
 * Products in groups: the watched products first, in watchlist order, then every other product under its sector,
 * sectors in `sectorOrder` and products in the API's order. Only products matching `filter` are kept, and a group
 * left empty is dropped. A watched root the API does not list is left out.
 */
export function groupSummaries(
  summaries: readonly InstrumentSummary[],
  watchlist: readonly string[],
  filter: string,
): SummaryGroup[] {
  const kept = summaries.filter((s) => matchesFilter(s.instrument, filter));
  const byRoot = new Map(kept.map((s) => [s.instrument.root, s]));
  const watched = new Set(watchlist);
  const groups: SummaryGroup[] = [];
  const watchedItems = watchlist.flatMap((root) => byRoot.get(root) ?? []);
  if (watchedItems.length > 0) {
    groups.push({ title: watchlistTitle, items: watchedItems });
  }
  const sectors = new Map<string, InstrumentSummary[]>();
  for (const item of kept) {
    if (watched.has(item.instrument.root)) continue;
    const list = sectors.get(item.instrument.sector);
    if (list) list.push(item);
    else sectors.set(item.instrument.sector, [item]);
  }
  const ordered = [...sectors.keys()].sort((a, b) => sectorRank(a) - sectorRank(b) || a.localeCompare(b));
  for (const sector of ordered) {
    groups.push({ title: sector, items: sectors.get(sector) ?? [] });
  }
  return groups;
}

/** The picker's groups (see `groupSummaries`), each product formatted as a row. */
export function groupProducts(
  summaries: readonly InstrumentSummary[],
  watchlist: readonly string[],
  filter: string,
): ProductGroup[] {
  return groupSummaries(summaries, watchlist, filter).map((g) => ({ title: g.title, rows: g.items.map(productRow) }));
}

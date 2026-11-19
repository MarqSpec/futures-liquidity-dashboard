import { z } from "zod";

import { positionsSchema, storedPositionsSchema, type Position } from "./position.ts";
import { signalKinds, type SignalKind } from "../api/schemas.ts";

/**
 * A product root as the API names it ("MES", "MNQ", "6E"). The list of products comes from GET /api/instruments;
 * the dashboard keeps no list of its own.
 */
export const instrumentRootSchema = z.string().regex(/^[A-Z0-9]{1,6}$/);

/** The three micro contracts the detail tabs switch between (REQUIREMENTS.md FR-10, ARCHITECTURE.md D-28). */
export const instrumentRoots = ["MES", "MCL", "MGC"] as const;
export type InstrumentRoot = (typeof instrumentRoots)[number];

/** The most products a viewer may watch; the server pulls depth for each, up to its own cap. */
export const watchlistLimit = 12;

/** The watchlist a viewer starts with: the three default tabs. */
export const defaultWatchlist: readonly string[] = ["MES", "MCL", "MGC"];

const watchlistSchema = z
  .array(instrumentRootSchema)
  .max(watchlistLimit)
  .refine((roots) => new Set(roots).size === roots.length, { message: "watchlist roots must be unique" });

/** Candles and heatmap columns share one of these intervals, in minutes. */
export const chartIntervals = [1, 2, 5, 15] as const;
export type ChartInterval = (typeof chartIntervals)[number];

/** Indicator source timeframe, chosen independently of the chart interval. */
export const indicatorIntervals = [1, 5, 15] as const;

/** Visible history, in minutes, past the old 60-minute cap. The labels are what the selector shows. */
export const historyChoices = [
  [30, "30m"],
  [60, "1h"],
  [240, "4h"],
  [1440, "1d"],
  [4320, "3d"],
] as const;

export const heatModes = ["intensity", "flow"] as const;
export type HeatMode = (typeof heatModes)[number];

/** Saved chart preset. `rips` emphasizes HVN and LVN; it does not recompute them (REQUIREMENTS.md FR-64). */
export const layoutPresets = ["standard", "rips"] as const;
export type LayoutPreset = (typeof layoutPresets)[number];

/** Order Flow event-marker size. Slice volume dots stay sized by print quantity. */
export const eventDotSizes = ["small", "medium", "large"] as const;
export type EventDotSize = (typeof eventDotSizes)[number];

/**
 * The indicator dock, one tab at a time (REQUIREMENTS.md FR-22), under the Detail and Order Flow charts alike.
 * `volume` is the tab a layout shows when it names none. `indicatorDockCollapsed` hides the tab and keeps the strip.
 */
export const indicatorPanes = ["volume", "cvd", "rsi14", "macd", "atr14", "tpo"] as const;
export type IndicatorPaneId = (typeof indicatorPanes)[number];

/** The dock tab before the footprint became Detail's main chart. A layout that still names it opens Volume. */
const RETIRED_FOOTPRINT_PANE = "footprint";

function withoutRetiredPane(value: unknown): unknown {
  return value === RETIRED_FOOTPRINT_PANE ? "volume" : value;
}

/** Detail's main chart (REQUIREMENTS.md FR-22, ARCHITECTURE.md D-55): the footprint by default, or the price chart. */
export const detailCharts = ["footprint", "price"] as const;
export type DetailChartId = (typeof detailCharts)[number];

/**
 * The bar timeframe, in seconds, whose range zones the price charts shade (REQUIREMENTS.md FR-75), or `off`. The same values as
 * the API's `LayoutSettings.RangeZoneTimeframe`; five-minute bars by default, so zones show within the replayed history.
 */
export const rangeZoneTimeframes = ["900", "300", "off"] as const;
export type RangeZoneTimeframe = (typeof rangeZoneTimeframes)[number];

/**
 * The Detail side-column sections that fold to their heading, in the column's order (ARCHITECTURE.md D-49).
 * The same keys as the API's `LayoutSettings.KnownSideSections`. Every section starts open.
 */
export const sideSections = ["ladder", "liquidity", "signals", "levels", "profile", "layers"] as const;
export type SideSectionId = (typeof sideSections)[number];

/** Known keys once each, in the column's order, so two equal sets always compare equal. */
function inColumnOrder(keys: readonly unknown[]): SideSectionId[] {
  return sideSections.filter((section) => keys.includes(section));
}

/**
 * The pane ids the API's LayoutSettings accepts (MarqSpec.FuturesLiquidityDashboard.Api/Layouts/LayoutSettings.cs).
 * `footprint`, `cvd`, `rsi14`, `macd`, `atr14` and `tpo` stay here so an older layout still saves. They no longer
 * drive the Detail dock or the main chart; `indicatorPane` and `detailChart` do (REQUIREMENTS.md FR-22). The same six are listed in `collapsedByDefault` below
 * only so `isPaneOn` stays false for them.
 */
export const paneIds = [
  "ema10",
  "ema13",
  "ema24",
  "ema48",
  "ema200",
  "vwap",
  "rsi14",
  "macd",
  "atr14",
  "heatmap",
  "footprint",
  "cvd",
  "profile-session",
  "profile-1h",
  "profile-4h",
  "profile-5d",
  "tpo",
  "ladder",
  "overlay",
  "range-zones",
] as const;
export type PaneId = (typeof paneIds)[number];

const knownPanes = new Set<string>(paneIds);
const knownSignals = new Set<string>(signalKinds);
const shownByDefault = new Set<string>(["Iceberg", "LiquiditySweep", "StackedImbalance"]);
// footprint, cvd, rsi14, macd, atr14 and tpo no longer drive the dock. See paneIds above.
const collapsedByDefault = new Set<string>([
  "footprint",
  "cvd",
  "rsi14",
  "macd",
  "atr14",
  "profile-session",
  "profile-1h",
  "profile-4h",
  "profile-5d",
  "tpo",
  "overlay",
]);

function knownFlags(keys: ReadonlySet<string>) {
  return z
    .record(z.string(), z.boolean())
    .transform((map) => Object.fromEntries(Object.entries(map).filter(([key]) => keys.has(key))));
}

function onlyKnown(keys: ReadonlySet<string>) {
  return knownFlags(keys).catch({});
}

/** Keeps the lower cutoff below the upper one, so a slider drag cannot invert the pair the server would reject. */
export function nextHeatCutoffs(
  low: number,
  high: number,
  edge: "low" | "high",
  next: number,
): { readonly heatLowPercentile: number; readonly heatHighPercentile: number } {
  if (edge === "low") {
    return { heatLowPercentile: Math.max(0, Math.min(next, high - 1)), heatHighPercentile: high };
  }
  return { heatLowPercentile: low, heatHighPercentile: Math.min(100, Math.max(next, low + 1)) };
}

/** An inverted pair is swapped; a pair that meets is put back to 5 and 95 so a later save is not rejected. */
export function orderedHeatCutoffs(low: number, high: number): { readonly heatLowPercentile: number; readonly heatHighPercentile: number } {
  if (high > low) return { heatLowPercentile: low, heatHighPercentile: high };
  if (low > high) return { heatLowPercentile: high, heatHighPercentile: low };
  return { heatLowPercentile: 5, heatHighPercentile: 95 };
}

function orderHeat<T extends { heatLowPercentile: number; heatHighPercentile: number }>(value: T): T {
  const cutoffs = orderedHeatCutoffs(value.heatLowPercentile, value.heatHighPercentile);
  if (cutoffs.heatLowPercentile === value.heatLowPercentile && cutoffs.heatHighPercentile === value.heatHighPercentile) {
    return value;
  }
  return { ...value, ...cutoffs };
}

/** One viewer's saved display settings (REQUIREMENTS.md FR-9, UC-8), lenient on input and always valid on output. */
export const layoutSchema = z.object({
  instrument: instrumentRootSchema.catch("MES"),
  sliceSeconds: z.union([z.literal(1), z.literal(5)]).catch(1),
  chartMinutes: z.union([z.literal(1), z.literal(2), z.literal(5), z.literal(15)]).catch(1),
  indicatorMinutes: z.union([z.literal(1), z.literal(5), z.literal(15)]).catch(1),
  heatMode: z.enum(heatModes).catch("intensity"),
  historyMinutes: z.number().int().min(5).max(4320).catch(240),
  heatContrast: z.number().min(0.1).max(5).catch(1),
  preset: z.enum(layoutPresets).catch("standard"),
  showCandles: z.boolean().catch(false),
  showVolumeDots: z.boolean().catch(true),
  heatDim: z.number().min(0).max(1).catch(0),
  heatLowPercentile: z.number().min(0).max(99).catch(5),
  heatHighPercentile: z.number().min(1).max(100).catch(95),
  heatAutoContrast: z.boolean().catch(true),
  dotMinQuantity: z.number().int().min(1).max(10_000).catch(1),
  eventDotSize: z.enum(eventDotSizes).catch("medium"),
  centerPrice: z.boolean().catch(false),
  indicatorPane: z.preprocess(withoutRetiredPane, z.enum(indicatorPanes)).catch("volume"),
  indicatorDockCollapsed: z.boolean().catch(false),
  detailChart: z.enum(detailCharts).catch("footprint"),
  rangeZoneTimeframe: z.enum(rangeZoneTimeframes).catch("300"),
  sideSectionsCollapsed: z.array(z.unknown()).transform(inColumnOrder).catch(() => []),
  showPriceLine: z.boolean().catch(true),
  hideValueArea: z.boolean().catch(false),
  emphasizeNodes: z.boolean().catch(false),
  positions: positionsSchema.catch(() => ({})),
  panes: onlyKnown(knownPanes),
  signals: onlyKnown(knownSignals),
  watchlist: watchlistSchema.catch(() => [...defaultWatchlist]),
}).transform(orderHeat);

export type LayoutSettings = z.infer<typeof layoutSchema>;

/** The API's default layout: everything shown. */
export const defaultLayout: LayoutSettings = {
  instrument: "MES",
  sliceSeconds: 1,
  chartMinutes: 1,
  indicatorMinutes: 1,
  heatMode: "intensity",
  historyMinutes: 240,
  heatContrast: 1,
  preset: "standard",
  showCandles: false,
  showVolumeDots: true,
  heatDim: 0,
  heatLowPercentile: 5,
  heatHighPercentile: 95,
  heatAutoContrast: true,
  dotMinQuantity: 1,
  eventDotSize: "medium",
  centerPrice: false,
  indicatorPane: "volume",
  indicatorDockCollapsed: false,
  detailChart: "footprint",
  rangeZoneTimeframe: "300",
  sideSectionsCollapsed: [],
  showPriceLine: true,
  hideValueArea: false,
  emphasizeNodes: false,
  positions: {},
  panes: {},
  signals: {},
  watchlist: [...defaultWatchlist],
};

/** Reads any stored or served value as a valid layout, falling back field by field to the defaults. */
export function toLayout(value: unknown): LayoutSettings {
  const parsed = layoutSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : defaultLayout;
}

/**
 * A layout kept in this browser. A present field that is not valid fails the parse. An unknown pane or signal
 * key is dropped. An omitted field takes the default, so an older document can omit a setting this client added later.
 */
export const storedLayoutSchema = z.object({
  instrument: instrumentRootSchema.default("MES"),
  sliceSeconds: z.union([z.literal(1), z.literal(5)]).default(1),
  chartMinutes: z.union([z.literal(1), z.literal(2), z.literal(5), z.literal(15)]).default(1),
  indicatorMinutes: z.union([z.literal(1), z.literal(5), z.literal(15)]).default(1),
  heatMode: z.enum(heatModes).default("intensity"),
  historyMinutes: z.number().int().min(5).max(4320).default(240),
  heatContrast: z.number().min(0.1).max(5).default(1),
  preset: z.enum(layoutPresets).default("standard"),
  showCandles: z.boolean().default(false),
  showVolumeDots: z.boolean().default(true),
  heatDim: z.number().min(0).max(1).default(0),
  heatLowPercentile: z.number().min(0).max(99).default(5),
  heatHighPercentile: z.number().min(1).max(100).default(95),
  heatAutoContrast: z.boolean().default(true),
  dotMinQuantity: z.number().int().min(1).max(10_000).default(1),
  eventDotSize: z.enum(eventDotSizes).default("medium"),
  centerPrice: z.boolean().default(false),
  indicatorPane: z.preprocess(withoutRetiredPane, z.enum(indicatorPanes)).default("volume"),
  indicatorDockCollapsed: z.boolean().default(false),
  detailChart: z.enum(detailCharts).default("footprint"),
  rangeZoneTimeframe: z.enum(rangeZoneTimeframes).default("300"),
  sideSectionsCollapsed: z.array(z.enum(sideSections)).transform(inColumnOrder).default(() => []),
  showPriceLine: z.boolean().default(true),
  hideValueArea: z.boolean().default(false),
  emphasizeNodes: z.boolean().default(false),
  positions: storedPositionsSchema.default(() => ({})),
  panes: knownFlags(knownPanes).default(() => ({})),
  signals: knownFlags(knownSignals).default(() => ({})),
  watchlist: watchlistSchema.default(() => [...defaultWatchlist]),
}).transform(orderHeat);

/** The stored layout when every present field is valid. A bad field is rejected, not replaced with a default. */
export function acceptStoredLayout(value: unknown): LayoutSettings | null {
  const parsed = storedLayoutSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Whether a pane is shown. The side profile and the overlay start collapsed; anything else, and a pane the server
 * adds later, starts on. An explicit layout value wins. Footprint, CVD, RSI, MACD, ATR and TPO are not stacked from
 * these flags: the Detail dock shows `indicatorPane` (REQUIREMENTS.md FR-22).
 */
export function isPaneOn(layout: LayoutSettings, pane: PaneId): boolean {
  const explicit = layout.panes[pane];
  if (explicit !== undefined) {
    return explicit;
  }
  return !collapsedByDefault.has(pane);
}

/**
 * Whether a signal kind is drawn. Icebergs, sweeps and stacked imbalances start on; the other known kinds start off
 * and can be toggled. A kind the server adds later stays on until the layout names it.
 */
export function isSignalOn(layout: LayoutSettings, kind: string): boolean {
  const explicit = layout.signals[kind];
  if (explicit !== undefined) {
    return explicit;
  }
  if (shownByDefault.has(kind)) {
    return true;
  }
  return !knownSignals.has(kind);
}

/**
 * The RIPS reading preset (REQUIREMENTS.md FR-64). Turning it on emphasizes HVN and LVN and keeps volume dots as the
 * price mark. Hiding VAH/VAL stays the viewer's own toggle. Stored POC and node values are not an input.
 */
export function withRipsPreset(layout: LayoutSettings, on: boolean): LayoutSettings {
  if (!on) {
    return { ...layout, preset: "standard", emphasizeNodes: false };
  }
  return { ...layout, preset: "rips", emphasizeNodes: true, showVolumeDots: true, showCandles: false };
}

/** The layout showing one indicator-dock tab. The same layout comes back when that tab is already selected. */
export function withIndicatorPane(layout: LayoutSettings, pane: IndicatorPaneId): LayoutSettings {
  if (layout.indicatorPane === pane) {
    return layout;
  }
  return { ...layout, indicatorPane: pane };
}

/** The layout showing one Detail main chart. The same layout comes back when that chart is already shown. */
export function withDetailChart(layout: LayoutSettings, chart: DetailChartId): LayoutSettings {
  if (layout.detailChart === chart) {
    return layout;
  }
  return { ...layout, detailChart: chart };
}

/**
 * The layout with `root`'s simulated position set, replaced or, with null, removed; every other root's is kept. One
 * position per product root (REQUIREMENTS.md FR-72).
 */
export function withPosition(layout: LayoutSettings, root: string, position: Position | null): LayoutSettings {
  const { [root]: _replaced, ...others } = layout.positions;
  return { ...layout, positions: position ? { ...others, [root]: position } : others };
}

/**
 * The layout with the indicator dock, on Detail and Order Flow, collapsed to its tab strip, or expanded
 * (ARCHITECTURE.md D-39).
 * The same layout comes back when the dock is already in that state.
 */
export function withIndicatorDockCollapsed(layout: LayoutSettings, collapsed: boolean): LayoutSettings {
  if (layout.indicatorDockCollapsed === collapsed) {
    return layout;
  }
  return { ...layout, indicatorDockCollapsed: collapsed };
}

/** Whether a Detail side-column section is folded to its heading. */
export function isSideSectionCollapsed(layout: LayoutSettings, section: SideSectionId): boolean {
  return layout.sideSectionsCollapsed.includes(section);
}

/**
 * The layout with one Detail side-column section folded to its heading, or opened (ARCHITECTURE.md D-49).
 * The same layout comes back when the section is already in that state.
 */
export function withSideSectionCollapsed(layout: LayoutSettings, section: SideSectionId, collapsed: boolean): LayoutSettings {
  if (isSideSectionCollapsed(layout, section) === collapsed) {
    return layout;
  }
  const next = collapsed ? [...layout.sideSectionsCollapsed, section] : layout.sideSectionsCollapsed.filter((key) => key !== section);
  return { ...layout, sideSectionsCollapsed: inColumnOrder(next) };
}

/** The layout with one pane toggled. */
export function withPane(layout: LayoutSettings, pane: PaneId, on: boolean): LayoutSettings {
  return { ...layout, panes: { ...layout.panes, [pane]: on } };
}

/** The layout with one signal kind toggled. */
export function withSignal(layout: LayoutSettings, kind: SignalKind, on: boolean): LayoutSettings {
  return { ...layout, signals: { ...layout.signals, [kind]: on } };
}

/** Whether `root` is on the layout's watchlist. */
export function isWatched(layout: LayoutSettings, root: string): boolean {
  return layout.watchlist.includes(root);
}

/**
 * The layout with `root` added to or removed from the watchlist. Adding to a full watchlist, or adding a root that
 * is not a valid one, returns the layout unchanged.
 */
export function withWatched(layout: LayoutSettings, root: string, on: boolean): LayoutSettings {
  const watched = isWatched(layout, root);
  if (on === watched) {
    return layout;
  }
  if (!on) {
    return { ...layout, watchlist: layout.watchlist.filter((r) => r !== root) };
  }
  if (layout.watchlist.length >= watchlistLimit || !instrumentRootSchema.safeParse(root).success) {
    return layout;
  }
  return { ...layout, watchlist: [...layout.watchlist, root] };
}

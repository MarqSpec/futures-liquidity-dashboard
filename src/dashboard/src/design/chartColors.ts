// The chart-colour roles a viewer may recolour, and how an override resolves. A colour is chosen per role, never per
// tab or pane, so a role means the same thing on every tab; the defaults are the active theme's tokens.
// No JSON import here, so it stays a pure module over a token file.

import { composite, contrastRatio } from "./color.ts";
import { BOOKMAP_STAGE, GRAPHIC, GRAPHIC_MINIMUM, SURFACES, TEXT, TEXT_MINIMUM, WARMUP_BAND_ALPHA } from "./contrastFloors.ts";
import { aliasTarget, resolveColor, type ThemeId, type TokenFile } from "./tokenFile.ts";

/** NFR-8's floor for a role: text 4.5:1, a line or marker 3:1, or none for a fill NFR-8 does not list. */
export type ChartColorFloor = "text" | "graphic" | "none";

/** Where a role is drawn. */
export type ChartTab = "Detail" | "Order Flow" | "Overview" | "Indicator dock" | "Side column";

/** How the settings panel samples the mark. */
export type ChartMark = "text" | "line" | "dot" | "ring" | "bar" | "fill";

export interface ChartColorRole {
  /** The colour token it overrides. */
  readonly token: string;
  /** Its plain-language name. */
  readonly name: string;
  /** The meaning it is grouped under. */
  readonly group: string;
  readonly mark: ChartMark;
  /** The marks it colours. */
  readonly marks: string;
  readonly tabs: readonly ChartTab[];
  readonly floor: ChartColorFloor;
}

/** The groups the settings panel lists, in order. */
export const CHART_COLOR_GROUPS: readonly string[] = [
  "Price direction",
  "Order book",
  "Heatmap",
  "Price",
  "Averages and indicators",
  "Levels",
  "Signal bias",
  "Order Flow events",
  "Warmup",
];

function floorOf(token: string): ChartColorFloor {
  if ((TEXT as readonly string[]).includes(token)) return "text";
  if ((GRAPHIC as readonly string[]).includes(token)) return "graphic";
  return "none";
}

type RoleSpec = Omit<ChartColorRole, "floor">;

const ALL: readonly ChartTab[] = ["Detail", "Order Flow", "Overview", "Indicator dock", "Side column"];
const CHARTS: readonly ChartTab[] = ["Detail", "Order Flow"];

function event(token: string, name: string, hollow: boolean): RoleSpec {
  return { token, name, group: "Order Flow events", mark: hollow ? "ring" : "dot", marks: `The ${name} event marker and its key swatch.`, tabs: ["Order Flow"] };
}

const SPECS: readonly RoleSpec[] = [
  { token: "up", name: "Buying / up", group: "Price direction", mark: "bar", marks: "Rising candles, buy volume and a volume dot's buy share, positive change and CVD, bullish signals, agreeing timeframes.", tabs: ALL },
  { token: "down", name: "Selling / down", group: "Price direction", mark: "bar", marks: "Falling candles, sell volume and a volume dot's base, negative change and CVD, bearish signals.", tabs: ALL },
  { token: "dot-outline-buy", name: "Buy outline", group: "Price direction", mark: "ring", marks: "The edge of a volume dot's buy share, the whole edge when it is all buying, on Detail and Order Flow.", tabs: CHARTS },
  { token: "dot-outline-sell", name: "Sell outline", group: "Price direction", mark: "ring", marks: "The edge of a volume dot's sell share, the whole edge when it is all selling, on Detail and Order Flow.", tabs: CHARTS },
  { token: "bid", name: "Bid depth", group: "Order book", mark: "bar", marks: "Resting bid depth, the ladder's bid bars, the imbalance bid share, the best-bid line and the DOM marker. The CVD line follows up and down.", tabs: ALL },
  { token: "ask", name: "Ask depth", group: "Order book", mark: "bar", marks: "Resting ask depth, the ladder's ask bars, the imbalance ask share, the best-ask line, conflicting timeframes.", tabs: ["Detail", "Order Flow", "Overview", "Side column"] },
  { token: "bid-strong", name: "Bid price text", group: "Order book", mark: "text", marks: "Bid prices as text in the depth ladder.", tabs: ["Side column"] },
  { token: "ask-strong", name: "Ask price text", group: "Order book", mark: "text", marks: "Ask prices as text in the depth ladder.", tabs: ["Side column"] },
  { token: "heat-0", name: "Heat: empty", group: "Heatmap", mark: "fill", marks: "The heat ramp at no resting quantity, the heatmap's ground.", tabs: CHARTS },
  { token: "heat-25", name: "Heat: thin", group: "Heatmap", mark: "fill", marks: "The heat ramp at a quarter of the heaviest resting quantity in view.", tabs: CHARTS },
  { token: "heat-50", name: "Heat: middle", group: "Heatmap", mark: "fill", marks: "The heat ramp at half of the heaviest resting quantity in view.", tabs: CHARTS },
  { token: "heat-75", name: "Heat: heavy", group: "Heatmap", mark: "fill", marks: "The heat ramp at three quarters of the heaviest resting quantity in view.", tabs: CHARTS },
  { token: "heat-100", name: "Heat: heaviest", group: "Heatmap", mark: "fill", marks: "The heat ramp at the heaviest resting quantity in view.", tabs: CHARTS },
  { token: "last-price", name: "Last price", group: "Price", mark: "line", marks: "The Detail last-price line, best bid and ask marks, starred products, third-touch levels.", tabs: ["Detail", "Side column"] },
  { token: "price-line", name: "Order Flow price line", group: "Price", mark: "line", marks: "The Order Flow last-price step; its halo turns to the opposite ink when needed.", tabs: ["Order Flow"] },
  { token: "vwap", name: "VWAP", group: "Averages and indicators", mark: "line", marks: "The VWAP line and its bands.", tabs: CHARTS },
  { token: "ema-10", name: "EMA 10", group: "Averages and indicators", mark: "line", marks: "The EMA 10 line and its Layers swatch.", tabs: ["Detail", "Side column"] },
  { token: "ema-13", name: "EMA 13", group: "Averages and indicators", mark: "line", marks: "The EMA 13 line and its Layers swatch.", tabs: ["Detail", "Side column"] },
  { token: "ema-24", name: "EMA 24", group: "Averages and indicators", mark: "line", marks: "The EMA 24 line and its Layers swatch.", tabs: ["Detail", "Side column"] },
  { token: "ema-48", name: "EMA 48", group: "Averages and indicators", mark: "line", marks: "The EMA 48 line and its Layers swatch.", tabs: ["Detail", "Side column"] },
  { token: "ema-200", name: "EMA 200", group: "Averages and indicators", mark: "line", marks: "The EMA 200 line and its Layers swatch.", tabs: ["Detail", "Side column"] },
  { token: "indicator-rsi", name: "RSI", group: "Averages and indicators", mark: "line", marks: "The RSI line.", tabs: ["Indicator dock"] },
  { token: "indicator-macd", name: "MACD", group: "Averages and indicators", mark: "line", marks: "The MACD line.", tabs: ["Indicator dock"] },
  { token: "indicator-macd-signal", name: "MACD signal", group: "Averages and indicators", mark: "line", marks: "The MACD signal line.", tabs: ["Indicator dock"] },
  { token: "indicator-atr", name: "ATR", group: "Averages and indicators", mark: "line", marks: "The ATR line.", tabs: ["Indicator dock"] },
  { token: "support", name: "Support", group: "Levels", mark: "line", marks: "Support levels and a key-level low.", tabs: ["Detail", "Side column"] },
  { token: "resistance", name: "Resistance", group: "Levels", mark: "line", marks: "Resistance levels and a key-level high.", tabs: ["Detail", "Side column"] },
  { token: "poc", name: "Point of control", group: "Levels", mark: "line", marks: "The POC line and bin, and the TPO outline.", tabs: ["Detail", "Order Flow", "Indicator dock", "Side column"] },
  { token: "value-area", name: "Value area", group: "Levels", mark: "fill", marks: "The value-area fill and bins, VAH and VAL.", tabs: ["Detail", "Order Flow", "Side column"] },
  { token: "node-hvn", name: "High-volume node", group: "Levels", mark: "line", marks: "The HVN shelf, its band and the HVN mark.", tabs: ["Detail", "Order Flow", "Side column"] },
  { token: "node-lvn", name: "Low-volume node", group: "Levels", mark: "line", marks: "The LVN shelf, its band and the LVN mark.", tabs: ["Detail", "Order Flow", "Side column"] },
  { token: "bias-bullish", name: "Bullish signal", group: "Signal bias", mark: "dot", marks: "A signal that implies price up: its chart marker and its row in the signal lists. Follows Buying / up until set.", tabs: ["Detail", "Overview", "Side column"] },
  { token: "bias-bearish", name: "Bearish signal", group: "Signal bias", mark: "dot", marks: "A signal that implies price down: its chart marker and its row in the signal lists. Follows Selling / down until set.", tabs: ["Detail", "Overview", "Side column"] },
  { token: "bias-neutral", name: "Neutral signal", group: "Signal bias", mark: "dot", marks: "A signal that implies neither direction: its chart marker and its row in the signal lists.", tabs: ["Detail", "Overview", "Side column"] },
  event("event-iceberg", "Iceberg (inferred)", true),
  event("event-stacked-imbalance", "Stacked imbalance", false),
  event("event-unfinished-auction", "Unfinished auction", false),
  event("event-trapped-traders", "Trapped traders", true),
  event("event-cvd-divergence", "CVD divergence", false),
  event("event-delta-exhaustion", "Delta exhaustion", false),
  event("event-spoof", "Spoof", true),
  event("event-liquidity-sweep", "Liquidity sweep (inferred)", true),
  event("event-single-prints", "Single prints", false),
  event("event-failed-reclaim", "Failed reclaim", true),
  event("event-unknown", "Unknown event", false),
  { token: "warmup", name: "Warmup", group: "Warmup", mark: "line", marks: "Warmup candles, the close line, CVD and volume before the live watermark, the warmup band, and, on the indicator dock under Detail and Order Flow, warmup and unsided bars on the Volume tab and the warmup stretch of the CVD tab.", tabs: ["Order Flow", "Indicator dock"] },
];

/** Every configurable role, with its NFR-8 floor read from the contrast lists. */
export const CHART_COLOR_ROLES: readonly ChartColorRole[] = SPECS.map((spec) => ({ ...spec, floor: floorOf(spec.token) }));

const ROLE_TOKENS = new Set(CHART_COLOR_ROLES.map((role) => role.token));

/** The contrast a floor asks for; 0 when it asks for none. */
export function floorMinimum(floor: ChartColorFloor): number {
  switch (floor) {
    case "text":
      return TEXT_MINIMUM;
    case "graphic":
      return GRAPHIC_MINIMUM;
    case "none":
      return 0;
  }
}

/** One theme's overrides: role token → six-digit hex. */
export type ThemeOverrides = Readonly<Record<string, string>>;

/** The overrides of both themes. */
export interface ChartColorOverrides {
  readonly dark: ThemeOverrides;
  readonly light: ThemeOverrides;
}

export const NO_OVERRIDES: ChartColorOverrides = Object.freeze({ dark: Object.freeze({}), light: Object.freeze({}) });

const HEX = /^#[0-9a-f]{6}$/i;

/** True for a six-digit hex colour, the only form the colour picker gives and the colour arithmetic reads. */
export function isChartColor(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

function parseTheme(raw: unknown): ThemeOverrides {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const kept: Record<string, string> = {};
  for (const [token, value] of Object.entries(raw)) {
    if (ROLE_TOKENS.has(token) && isChartColor(value)) kept[token] = value.toLowerCase();
  }
  return kept;
}

/** The stored overrides with every unknown role and every value that is not a colour dropped. */
export function parseChartColorOverrides(raw: unknown): ChartColorOverrides {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { dark: {}, light: {} };
  const record = raw as Record<string, unknown>;
  return { dark: parseTheme(record.dark), light: parseTheme(record.light) };
}

/** Whichever of `inks` reads best on every one of `grounds`; the first wins a tie. */
function bestInk(inks: readonly [string, string], grounds: readonly string[]): string {
  const worst = (ink: string) => Math.min(...grounds.map((ground) => contrastRatio(ink, ground)));
  return worst(inks[1]) > worst(inks[0]) ? inks[1] : inks[0];
}

/**
 * Tokens that are not chosen but follow the roles they are drawn with: the live price line's halo is its opposite ink,
 * and a volume dot's label and its halo are the two inks, the label taking whichever reads better on both slices. The
 * halo outside a volume dot's outline is whichever of the two inks reads better on both outlines.
 */
function derived(file: TokenFile, token: string, theme: ThemeId, overrides: ThemeOverrides): string | undefined {
  const base = (name: string) => resolveColor(file, name, theme);
  const live = (name: string) => resolveChartColor(file, name, theme, overrides);
  switch (token) {
    case "price-line-halo":
      return bestInk([base(token), base("price-line")], [live("price-line")]);
    case "dot-label":
    case "dot-label-halo": {
      const slices = [live("aggressor-buy"), live("aggressor-sell")];
      const label = bestInk([base("dot-label"), base("dot-label-halo")], slices);
      if (token === "dot-label") return label;
      return label === base("dot-label") ? base("dot-label-halo") : base("dot-label");
    }
    case "dot-outline-halo":
      return bestInk([base("dot-label"), base("dot-label-halo")], [live("dot-outline-buy"), live("dot-outline-sell")]);
    default:
      return undefined;
  }
}

/**
 * A colour token's value in `theme` with that theme's overrides applied: an override anywhere along the `{alias}`
 * chain wins, so `aggressor-buy` follows `up`, and the derived halo and label inks follow the roles under them.
 */
export function resolveChartColor(file: TokenFile, token: string, theme: ThemeId, overrides: ThemeOverrides): string {
  if (Object.keys(overrides).length === 0) return resolveColor(file, token, theme);
  const seen = new Set<string>();
  let current = token;
  for (;;) {
    if (seen.has(current)) throw new Error(`Colour token alias cycle through "${current}"`);
    seen.add(current);
    const chosen = Object.hasOwn(overrides, current) ? overrides[current] : undefined;
    if (chosen !== undefined) return chosen;
    const follows = derived(file, current, theme, overrides);
    if (follows !== undefined) return follows;
    const entry = file.color.tokens.find((candidate) => candidate.name === current);
    if (!entry) throw new Error(`No colour token named "${current}"`);
    const value = typeof entry.value === "string" ? entry.value : entry.value[theme];
    const target = aliasTarget(value);
    if (target === undefined) return value;
    current = target;
  }
}

export interface RoleContrast {
  /** The worst contrast of the colour on the six surfaces and the Order Flow warmup band. */
  readonly ratio: number;
  /** The role's NFR-8 floor; 0 when it has none. */
  readonly minimum: number;
  /** True when the colour falls below that floor: the panel warns, and the choice still stands. */
  readonly below: boolean;
}

/** `colour` as `token`'s colour in `theme`: its worst contrast on the grounds NFR-8 holds the role to. */
export function roleContrast(file: TokenFile, token: string, colour: string, theme: ThemeId, overrides: ThemeOverrides): RoleContrast {
  const warmup = token === "warmup" ? colour : resolveChartColor(file, "warmup", theme, overrides);
  const band = composite(warmup, WARMUP_BAND_ALPHA, resolveColor(file, BOOKMAP_STAGE, theme));
  const grounds = [...SURFACES.map((surface) => resolveColor(file, surface, theme)), band];
  const ratio = Math.min(...grounds.map((ground) => contrastRatio(colour, ground)));
  const role = CHART_COLOR_ROLES.find((candidate) => candidate.token === token);
  const minimum = floorMinimum(role?.floor ?? "none");
  return { ratio, minimum, below: ratio < minimum };
}

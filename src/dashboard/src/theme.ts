// Canvas colours of the active theme, read from the design tokens (src/design/tokens.json) that index.css uses too.
// Alpha variants are built from these with withAlpha (design/color.ts), never retyped.
// This module is the one override layer: every colour token is read here, through the viewer's chart colours.

import { CHART_COLOR_ROLES, resolveChartColor, type ThemeOverrides } from "./design/chartColors.ts";
import { rgbTriplet } from "./design/color.ts";
import type { ThemeId } from "./design/tokenFile.ts";
import { color as tokenColor, fontFamilies, sizePx, tokens, typeStyle } from "./design/tokens.ts";
import { chartColorStore } from "./lib/chartColorOverrides.ts";

let activeTheme: ThemeId = "dark";
const themeListeners = new Set<() => void>();

/**
 * A colour token's value in `theme` (the active canvas theme by default) with the viewer's overrides for that theme:
 * the one place a canvas, a draw function or the page reads a colour.
 */
export function themeColor(name: string, theme: ThemeId = activeTheme): string {
  return resolveChartColor(tokens, name, theme, chartColorStore.overrides()[theme]);
}

let paletteCache: { readonly theme: ThemeId; readonly overrides: ThemeOverrides; readonly key: string } | undefined;

/** The active theme, plus its overrides when it has any: equal keys draw equal colours. */
function paletteKey(): string {
  const overrides = chartColorStore.overrides()[activeTheme];
  if (paletteCache?.theme === activeTheme && paletteCache.overrides === overrides) return paletteCache.key;
  const entries = Object.entries(overrides).sort(([a], [b]) => (a < b ? -1 : 1));
  const key = entries.length === 0 ? activeTheme : `${activeTheme}|${entries.map(([token, value]) => `${token}=${value}`).join(",")}`;
  paletteCache = { theme: activeTheme, overrides, key };
  return key;
}

/**
 * The theme the canvases draw in: Terminal (`dark`) until the app applies the viewer's choice. An external store for
 * `useSyncExternalStore`; a change of theme or of a chart colour tells every subscriber once, so each canvas repaints
 * once. `palette` is what a cached frame keys on: the theme alone until a colour of it is overridden.
 */
export const canvasTheme = {
  current: (): ThemeId => activeTheme,
  palette: (): string => paletteKey(),
  subscribe: (listener: () => void): (() => void) => {
    themeListeners.add(listener);
    const unsubscribeColors = chartColorStore.subscribe(listener);
    return () => {
      themeListeners.delete(listener);
      unsubscribeColors();
    };
  },
  set: (theme: ThemeId): void => {
    if (theme === activeTheme) return;
    activeTheme = theme;
    for (const listener of [...themeListeners]) listener();
  },
} as const;

/** `build(theme)` for the active canvas theme, built once per palette: again when the theme or its colours change. */
export function perTheme<T>(build: (theme: ThemeId) => T): () => T {
  const built = new Map<string, T>();
  return () => {
    const key = paletteKey();
    const cached = built.get(key);
    if (cached !== undefined) return cached;
    const value = build(activeTheme);
    // A colour dragged through the picker makes a palette per step; keep only the latest few.
    if (built.size >= 4) built.clear();
    built.set(key, value);
    return value;
  };
}

/**
 * A record whose every property reads `build(theme)` for the active canvas theme, built once per theme. Draw code
 * reads `palette.key` at draw time, so a theme switch changes what the next paint uses.
 */
export function themed<T extends Readonly<Record<string, unknown>>>(build: (theme: ThemeId) => T): T {
  const current = perTheme(build);
  const live = {} as T;
  for (const key of Object.keys(current())) {
    Object.defineProperty(live, key, { enumerable: true, get: () => current()[key] });
  }
  return Object.freeze(live);
}

/** The canvas colours of `theme`. */
export function canvasColors(theme: ThemeId) {
  const color = (name: string) => themeColor(name, theme);
  return {
    background: color("surface"),
    panel: color("surface-container"),
    grid: color("surface-highest"),
    axis: color("on-surface-muted"),
    text: color("on-surface-variant"),
    muted: color("on-surface-muted"),
    up: color("up"),
    down: color("down"),
    bid: color("bid"),
    ask: color("ask"),
    bidRgb: rgbTriplet(color("bid")),
    askRgb: rgbTriplet(color("ask")),
    addedRgb: rgbTriplet(color("depth-added")),
    pulledRgb: rgbTriplet(color("depth-pulled")),
    unknown: color("unknown"),
    aggressorBuy: color("aggressor-buy"),
    aggressorSell: color("aggressor-sell"),
    vwap: color("vwap"),
    crosshair: color("crosshair"),
    lastPrice: color("last-price"),
    poc: color("poc"),
    value: color("value-area"),
    support: color("support"),
    resistance: color("resistance"),
    reference: color("reference"),
    /** Strong text on a chart chip: the crosshair readouts, a marker's outline. */
    strong: color("on-surface"),
    /** Fill of a readout chip on an axis. */
    chip: color("surface-highest"),
    /** Fill behind a label laid over a plot. */
    scrim: color("scrim-chart"),
    /** Text on a bid or ask fill. */
    onMarket: color("surface-lowest"),
    priceTag: color("price-tag"),
    onPriceTag: color("on-price-tag"),
    nodeHvn: color("node-hvn"),
    nodeLvn: color("node-lvn"),
    /** A profile bin outside the value area, the same grey as a single print. */
    single: color("highlight-single"),
    /** The ground of the heatmap: no resting quantity. */
    heatGround: color("heat-0"),
    /** The provenance watermark when the feed is not LIVE. */
    warning: color("status-simulated"),
    /** What a signal implies for price: its marker and its row in the signal lists. */
    biasBullish: color("bias-bullish"),
    biasBearish: color("bias-bearish"),
    biasNeutral: color("bias-neutral"),
  } as const;
}

/** Shared colours for every canvas pane, in the active canvas theme. */
export const colors: ReturnType<typeof canvasColors> = themed(canvasColors);

/** EMA line colours by indicator id, in the active canvas theme. */
export const emaColors: Readonly<Record<string, string>> = themed((theme) => ({
  ema10: themeColor("ema-10", theme),
  ema13: themeColor("ema-13", theme),
  ema24: themeColor("ema-24", theme),
  ema48: themeColor("ema-48", theme),
  ema200: themeColor("ema-200", theme),
}));

/** Line colours of the indicator panes, in the active canvas theme. */
export const indicatorColors = themed((theme) => ({
  rsi: themeColor("indicator-rsi", theme),
  macd: themeColor("indicator-macd", theme),
  macdSignal: themeColor("indicator-macd-signal", theme),
  atr: themeColor("indicator-atr", theme),
}));

/** The tokens the page's stylesheet may need overridden: every role, and the inks derived from them. */
const DOCUMENT_TOKENS = [...CHART_COLOR_ROLES.map((role) => role.token), "price-line-halo", "dot-label", "dot-label-halo"];

/**
 * Puts `theme`'s chart colours on the page: each token whose colour differs from the theme default is set inline on
 * `<html>`, which wins over tokens.css, so every `var(--role)` and every alias of it follows; the rest are cleared.
 */
export function applyDocumentChartColors(doc: Document, theme: ThemeId): void {
  const style = doc.documentElement.style;
  for (const token of DOCUMENT_TOKENS) {
    const value = themeColor(token, theme);
    if (value === tokenColor(token, theme)) style.removeProperty(`--${token}`);
    else style.setProperty(`--${token}`, value);
  }
}

/** Width of the price axis on the right of every time-aligned pane, so their time axes line up. */
export const AXIS_WIDTH = sizePx("axis-width");

/** Width of the volume-profile gutter on the left of the main chart. */
export const PROFILE_GUTTER = sizePx("profile-gutter");

/** The monospace font canvases draw text in: bundled IBM Plex Mono, then the system stack. */
export const MONO = fontFamilies.mono;

function canvasFont(role: string, weight?: number): string {
  const style = typeStyle(role);
  return `${weight ?? style.fontWeight} ${style.fontSize} ${MONO}`;
}

/** Canvas text faces: IBM Plex Mono at the data-xs and data-sm sizes. */
export const fonts = {
  xs: canvasFont("data-xs"),
  sm: canvasFont("data-sm"),
  /** The last-price tag on the price axis; every axis tag is data-xs. */
  tag: canvasFont("data-xs", 600),
  /** A signal's letter inside its marker. */
  mark: canvasFont("data-xs", 700),
} as const;

/** The Order Flow canvas's faces beyond `fonts`: the label-sm column heads in IBM Plex Sans, and the data-xl CVD value. */
export const orderFlowFonts = {
  label: `${typeStyle("label-sm").fontWeight} ${typeStyle("label-sm").fontSize} ${fontFamilies.sans}`,
  cvd: canvasFont("data-xl"),
} as const;

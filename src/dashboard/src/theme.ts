// Canvas colours of the active theme, read from the design tokens (src/design/tokens.json) that index.css uses too.
// Alpha variants are built from these with withAlpha (design/color.ts), never retyped.

import { rgbTriplet } from "./design/color.ts";
import type { ThemeId } from "./design/tokenFile.ts";
import { color as tokenColor, fontFamilies, sizePx, typeStyle } from "./design/tokens.ts";

let activeTheme: ThemeId = "dark";
const themeListeners = new Set<() => void>();

/**
 * The theme the canvases draw in: Terminal (`dark`) until the app applies the viewer's choice. An external store for
 * `useSyncExternalStore`; a change tells every subscriber once, so each canvas repaints once.
 */
export const canvasTheme = {
  current: (): ThemeId => activeTheme,
  subscribe: (listener: () => void): (() => void) => {
    themeListeners.add(listener);
    return () => {
      themeListeners.delete(listener);
    };
  },
  set: (theme: ThemeId): void => {
    if (theme === activeTheme) return;
    activeTheme = theme;
    for (const listener of [...themeListeners]) listener();
  },
} as const;

/** `build(theme)` for the active canvas theme, built once per theme. */
export function perTheme<T>(build: (theme: ThemeId) => T): () => T {
  const built = new Map<ThemeId, T>();
  return () => {
    const theme = activeTheme;
    const cached = built.get(theme);
    if (cached !== undefined) return cached;
    const value = build(theme);
    built.set(theme, value);
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
  const color = (name: string) => tokenColor(name, theme);
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
  ema10: tokenColor("ema-10", theme),
  ema13: tokenColor("ema-13", theme),
  ema24: tokenColor("ema-24", theme),
  ema48: tokenColor("ema-48", theme),
  ema200: tokenColor("ema-200", theme),
}));

/** Line colours of the indicator panes, in the active canvas theme. */
export const indicatorColors = themed((theme) => ({
  rsi: tokenColor("indicator-rsi", theme),
  macd: tokenColor("indicator-macd", theme),
  macdSignal: tokenColor("indicator-macd-signal", theme),
  atr: tokenColor("indicator-atr", theme),
}));

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

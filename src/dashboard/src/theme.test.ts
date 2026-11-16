import { afterEach, describe, expect, it, vi } from "vitest";

import { rgbTriplet } from "./design/color.ts";
import { color } from "./design/tokens.ts";
import { AXIS_WIDTH, canvasColors, canvasTheme, colors, emaColors, fonts, indicatorColors, MONO, PROFILE_GUTTER, themed } from "./theme.ts";

// Terminal must look as it did before the design tokens: these are the canvas colours it drew, with the one
// deliberate change, muted text #6b7587 → on-surface-muted #8b95a7. A separate change adds the chart chrome below `reference`.
// a separate change then moved the price-direction pair on purpose: up #26a69a → #6f84ff, down #ef5350 → #b0b0b0, and what
// follows them (aggressor, bias); resistance and pulled depth keep the red.

describe("theme", () => {
  it("should give the canvases the Terminal colours when they draw", () => {
    expect(colors).toEqual({
      background: "#0b0e14",
      panel: "#11151d",
      grid: "#1c2230",
      axis: "#8b95a7",
      text: "#c9d1dc",
      muted: "#8b95a7",
      up: "#6f84ff",
      down: "#b0b0b0",
      bid: "#29b6f6",
      ask: "#ff7043",
      bidRgb: "41, 182, 246",
      askRgb: "255, 112, 67",
      addedRgb: "102, 187, 106",
      pulledRgb: "239, 83, 80",
      unknown: "#3a3f4b",
      aggressorBuy: "#6f84ff",
      aggressorSell: "#b0b0b0",
      vwap: "#e040fb",
      crosshair: "#9aa5b8",
      lastPrice: "#ffd54f",
      poc: "#ffca28",
      value: "#7e57c2",
      support: "#66bb6a",
      resistance: "#ef5350",
      reference: "#78909c",
      strong: "#eef2f7",
      chip: "#1c2230",
      scrim: "rgba(17, 21, 29, 0.88)",
      onMarket: "#08090c",
      priceTag: "#f5d76e",
      onPriceTag: "#1a1404",
      nodeHvn: "#ffd54f",
      nodeLvn: "#4fc3f7",
      single: "rgba(144, 164, 174, 0.18)",
      heatGround: "#000000",
      warning: "#f9a825",
      biasBullish: "#6f84ff",
      biasBearish: "#b0b0b0",
      biasNeutral: "#90a4ae",
    });
  });

  it("should give the EMA lines their Terminal colours when an indicator is drawn", () => {
    expect(emaColors).toEqual({
      ema10: "#fff176",
      ema13: "#ffb74d",
      ema24: "#ba68c8",
      ema48: "#4fc3f7",
      ema200: "#eceff1",
    });
  });

  it("should give the indicator panes' lines their Terminal colours when RSI, MACD and ATR are drawn", () => {
    expect(indicatorColors).toEqual({ rsi: "#ffb74d", macd: "#4fc3f7", macdSignal: "#ff8a65", atr: "#aed581" });
  });

  it("should give the axis and gutter widths in pixels when panes are laid out", () => {
    expect(AXIS_WIDTH).toBe(68);
    expect(PROFILE_GUTTER).toBe(72);
  });

  it("should draw canvas text in the bundled mono family with the system stack behind it", () => {
    expect(MONO).toBe('"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace');
  });

  it("should set canvas text at the data-xs and data-sm sizes when a canvas writes", () => {
    expect(fonts).toEqual({
      xs: `400 10px ${MONO}`,
      sm: `400 11px ${MONO}`,
      tag: `600 10px ${MONO}`,
      mark: `700 10px ${MONO}`,
    });
  });
});

// The canvases read the active theme's token values, so a theme switch can repaint them.
describe("canvasTheme", () => {
  afterEach(() => canvasTheme.set("dark"));

  it("should give the canvases the Light colours when the canvas theme is light", () => {
    canvasTheme.set("light");

    expect({ ...colors }).toEqual(canvasColors("light"));
    expect([colors.background, colors.grid, colors.heatGround, colors.bidRgb]).toEqual([
      color("surface", "light"),
      color("surface-highest", "light"),
      "#efede7",
      rgbTriplet(color("bid", "light")),
    ]);
  });

  it("should give the EMA and indicator lines their Light colours when the canvas theme is light", () => {
    canvasTheme.set("light");

    expect(emaColors.ema200).toBe(color("ema-200", "light"));
    expect(indicatorColors).toEqual({
      rsi: color("indicator-rsi", "light"),
      macd: color("indicator-macd", "light"),
      macdSignal: color("indicator-macd-signal", "light"),
      atr: color("indicator-atr", "light"),
    });
  });

  it("should give the Terminal colours back when the canvas theme returns to dark", () => {
    canvasTheme.set("light");
    canvasTheme.set("dark");

    expect(canvasTheme.current()).toBe("dark");
    expect({ ...colors }).toEqual(canvasColors("dark"));
    expect(colors.background).toBe("#0b0e14");
  });

  it("should tell each subscriber once when the theme changes and not when it is set to the theme it has", () => {
    const listener = vi.fn();
    const unsubscribe = canvasTheme.subscribe(listener);

    canvasTheme.set("dark");
    canvasTheme.set("light");
    canvasTheme.set("light");
    unsubscribe();
    canvasTheme.set("dark");

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("should build a themed value once per theme and read the active theme's when a property is read", () => {
    const build = vi.fn((theme: "dark" | "light") => ({ ground: color("surface", theme) }));
    const live = themed(build);

    const reads = [live.ground, live.ground];
    canvasTheme.set("light");
    reads.push(live.ground, live.ground);

    expect(reads).toEqual(["#0b0e14", "#0b0e14", "#e7e6df", "#e7e6df"]);
    expect(build.mock.calls.map(([theme]) => theme)).toEqual(["dark", "light"]);
  });
});

import { describe, expect, it } from "vitest";

import {
  defaultLayout,
  isPaneOn,
  isSideSectionCollapsed,
  isSignalOn,
  isWatched,
  orderedHeatCutoffs,
  toLayout,
  watchlistLimit,
  withDetailChart,
  withIndicatorDockCollapsed,
  withPane,
  withRipsPreset,
  withSideSectionCollapsed,
  withSignal,
  withWatched,
} from "./layout.ts";

describe("toLayout", () => {
  it("should read the API's default layout when it is served", () => {
    const served = { instrument: "MES", sliceSeconds: 1, historyMinutes: 240, heatContrast: 1, panes: {}, signals: {} };

    expect(toLayout(served)).toEqual(defaultLayout);
  });

  it("should drop pane ids the API would refuse when a stored layout has them", () => {
    expect(toLayout({ ...defaultLayout, panes: { heatmap: false, bogus: true } }).panes).toEqual({ heatmap: false });
  });

  it("should fall back to 4 hours when the history is out of range", () => {
    expect(toLayout({ ...defaultLayout, historyMinutes: 99999 }).historyMinutes).toBe(240);
  });

  it("should keep a 1 day history when it is inside the new cap", () => {
    expect(toLayout({ ...defaultLayout, historyMinutes: 1440 }).historyMinutes).toBe(1440);
  });

  it("should return the defaults when the stored value is not an object", () => {
    expect(toLayout("garbage")).toEqual(defaultLayout);
  });

  it("should keep a product root the API lists when it is not one of the original three", () => {
    expect(toLayout({ ...defaultLayout, instrument: "MNQ" }).instrument).toBe("MNQ");
  });

  it("should keep a root that starts with a digit when the product is a currency future", () => {
    expect(toLayout({ ...defaultLayout, instrument: "6E" }).instrument).toBe("6E");
  });

  it.each(["es", "TOOLONG1", "", "E-S", 42])("should fall back to MES when the root is %j", (instrument) => {
    expect(toLayout({ ...defaultLayout, instrument }).instrument).toBe("MES");
  });

  it("should default the watchlist to MES, MCL and MGC when an older layout has none", () => {
    const { watchlist: _watchlist, ...older } = defaultLayout;

    expect(toLayout(older).watchlist).toEqual(["MES", "MCL", "MGC"]);
  });

  it("should keep the watchlist in its order when every root is valid and unique", () => {
    expect(toLayout({ ...defaultLayout, watchlist: ["NQ", "6E", "CL"] }).watchlist).toEqual(["NQ", "6E", "CL"]);
  });

  it("should fall back to the default watchlist when a root repeats", () => {
    expect(toLayout({ ...defaultLayout, watchlist: ["NQ", "NQ"] }).watchlist).toEqual(["MES", "MCL", "MGC"]);
  });

  it("should fall back to the default watchlist when it holds more than the limit", () => {
    const tooMany = Array.from({ length: watchlistLimit + 1 }, (_, i) => `R${i}`);

    expect(toLayout({ ...defaultLayout, watchlist: tooMany }).watchlist).toEqual(["MES", "MCL", "MGC"]);
  });

  it("should fall back to the default watchlist when a root does not match the pattern", () => {
    expect(toLayout({ ...defaultLayout, watchlist: ["ES", "gc"] }).watchlist).toEqual(["MES", "MCL", "MGC"]);
  });

  it("should allow an empty watchlist when the viewer removed every product", () => {
    expect(toLayout({ ...defaultLayout, watchlist: [] }).watchlist).toEqual([]);
  });
});

describe("withWatched", () => {
  it("should append the root when it is added", () => {
    expect(withWatched(defaultLayout, "NQ", true).watchlist).toEqual(["MES", "MCL", "MGC", "NQ"]);
  });

  it("should remove the root when it is taken off", () => {
    expect(isWatched(withWatched(defaultLayout, "MCL", false), "MCL")).toBe(false);
  });

  it("should return the same layout when the root is already watched", () => {
    expect(withWatched(defaultLayout, "MES", true)).toBe(defaultLayout);
  });

  it("should not add a root when the watchlist is full", () => {
    const full = { ...defaultLayout, watchlist: Array.from({ length: watchlistLimit }, (_, i) => `R${i}`) };

    expect(withWatched(full, "NQ", true).watchlist).toHaveLength(watchlistLimit);
  });

  it("should not add a root that does not match the pattern", () => {
    expect(withWatched(defaultLayout, "nq", true)).toBe(defaultLayout);
  });
});

describe("isPaneOn", () => {
  it("should leave the heatmap on when the layout does not mention it", () => {
    expect(isPaneOn(defaultLayout, "heatmap")).toBe(true);
  });

  it("should collapse a lower pane when the layout does not mention it", () => {
    expect(isPaneOn(defaultLayout, "tpo")).toBe(false);
  });

  it("should be off when the pane was toggled off", () => {
    expect(isPaneOn(withPane(defaultLayout, "tpo", false), "tpo")).toBe(false);
  });
});

describe("isSignalOn", () => {
  it("should show icebergs, sweeps and imbalances when the layout does not say", () => {
    expect(isSignalOn(defaultLayout, "Iceberg")).toBe(true);
    expect(isSignalOn(defaultLayout, "LiquiditySweep")).toBe(true);
    expect(isSignalOn(defaultLayout, "StackedImbalance")).toBe(true);
  });

  it("should hide the other known kinds until they are toggled on", () => {
    expect(isSignalOn(defaultLayout, "Spoof")).toBe(false);
    expect(isSignalOn(withSignal(defaultLayout, "Spoof", true), "Spoof")).toBe(true);
  });

  it("should be off when the kind was toggled off", () => {
    expect(isSignalOn(withSignal(defaultLayout, "Iceberg", false), "Iceberg")).toBe(false);
  });

  it("should treat a kind the server added later as on", () => {
    expect(isSignalOn(defaultLayout, "SomethingNew")).toBe(true);
  });

  it("should restore the RIPS preset and the value-area toggle when the layout is read back", () => {
    const saved = { ...withRipsPreset(defaultLayout, true), hideValueArea: true };
    const restored = toLayout(JSON.parse(JSON.stringify(saved)));

    expect(saved.preset).toBe("rips");
    expect(saved.emphasizeNodes).toBe(true);
    expect(saved.showCandles).toBe(false);
    expect(saved.showVolumeDots).toBe(true);
    expect(saved.hideValueArea).toBe(true);
    expect(restored).toEqual(saved);
  });

  it("should default event dot size when an older layout omits it and keep a known step", () => {
    const { eventDotSize: _size, ...older } = defaultLayout;

    expect(toLayout(older).eventDotSize).toBe("medium");
    expect(toLayout({ ...defaultLayout, eventDotSize: "large" }).eventDotSize).toBe("large");
    expect(toLayout({ ...defaultLayout, eventDotSize: "huge" }).eventDotSize).toBe("medium");
    const { centerPrice: _lock, ...unlocked } = defaultLayout;
    expect(toLayout(unlocked).centerPrice).toBe(false);
    expect(toLayout({ ...defaultLayout, centerPrice: true }).centerPrice).toBe(true);
    const { showPriceLine: _line, ...withoutLine } = defaultLayout;
    expect(toLayout(withoutLine).showPriceLine).toBe(true);
    expect(toLayout({ ...defaultLayout, showPriceLine: false }).showPriceLine).toBe(false);
  });

  it("should default the indicator pane to volume when the layout omits it", () => {
    const { indicatorPane: _pane, ...older } = defaultLayout;

    expect(toLayout(older).indicatorPane).toBe("volume");
    expect(defaultLayout.indicatorPane).toBe("volume");
  });

  it("should keep a known indicator pane and fall back to volume when the served value is unknown", () => {
    expect(toLayout({ ...defaultLayout, indicatorPane: "rsi14" }).indicatorPane).toBe("rsi14");
    expect(toLayout({ ...defaultLayout, indicatorPane: "tpo" }).indicatorPane).toBe("tpo");
    expect(toLayout({ ...defaultLayout, indicatorPane: "cvd" }).indicatorPane).toBe("cvd");
    expect(toLayout({ ...defaultLayout, indicatorPane: "volumes" }).indicatorPane).toBe("volume");
    expect(toLayout({ ...defaultLayout, indicatorPane: null }).indicatorPane).toBe("volume");
  });

  it("should read a served footprint tab as volume when the server still holds the retired tab", () => {
    expect(toLayout({ ...defaultLayout, indicatorPane: "footprint" }).indicatorPane).toBe("volume");
  });

  it("should open Detail on the footprint when the layout omits the main chart or serves one the client does not know", () => {
    const { detailChart: _chart, ...older } = defaultLayout;

    expect(defaultLayout.detailChart).toBe("footprint");
    expect(toLayout(older).detailChart).toBe("footprint");
    expect(toLayout({ ...defaultLayout, detailChart: "price" }).detailChart).toBe("price");
    expect(toLayout({ ...defaultLayout, detailChart: "candles" }).detailChart).toBe("footprint");
    expect(toLayout({ ...defaultLayout, detailChart: "Price" }).detailChart).toBe("footprint");
    expect(toLayout({ ...defaultLayout, detailChart: null }).detailChart).toBe("footprint");
  });

  it("should switch the main chart and return the same layout when it is already shown", () => {
    const price = withDetailChart(defaultLayout, "price");

    expect(price.detailChart).toBe("price");
    expect(price.indicatorPane).toBe(defaultLayout.indicatorPane);
    expect(withDetailChart(price, "footprint").detailChart).toBe("footprint");
    expect(withDetailChart(defaultLayout, "footprint")).toBe(defaultLayout);
  });

  it("should expand the indicator dock when the layout omits the flag or serves a value that is not a boolean", () => {
    const { indicatorDockCollapsed: _collapsed, ...older } = defaultLayout;

    expect(defaultLayout.indicatorDockCollapsed).toBe(false);
    expect(toLayout(older).indicatorDockCollapsed).toBe(false);
    expect(toLayout({ ...defaultLayout, indicatorDockCollapsed: true }).indicatorDockCollapsed).toBe(true);
    expect(toLayout({ ...defaultLayout, indicatorDockCollapsed: "true" }).indicatorDockCollapsed).toBe(false);
    expect(toLayout({ ...defaultLayout, indicatorDockCollapsed: null }).indicatorDockCollapsed).toBe(false);
  });

  it("should collapse or expand the dock and return the same layout when nothing changes", () => {
    const collapsed = withIndicatorDockCollapsed(defaultLayout, true);

    expect(collapsed.indicatorDockCollapsed).toBe(true);
    expect(collapsed.indicatorPane).toBe(defaultLayout.indicatorPane);
    expect(withIndicatorDockCollapsed(collapsed, false).indicatorDockCollapsed).toBe(false);
    expect(withIndicatorDockCollapsed(defaultLayout, false)).toBe(defaultLayout);
  });

  it("should open every side section when the layout omits the list or serves one that is not a list", () => {
    const { sideSectionsCollapsed: _collapsed, ...older } = defaultLayout;

    expect(defaultLayout.sideSectionsCollapsed).toEqual([]);
    expect(toLayout(older).sideSectionsCollapsed).toEqual([]);
    expect(toLayout({ ...defaultLayout, sideSectionsCollapsed: ["layers", "ladder"] }).sideSectionsCollapsed).toEqual(["ladder", "layers"]);
    expect(toLayout({ ...defaultLayout, sideSectionsCollapsed: "ladder" }).sideSectionsCollapsed).toEqual([]);
    expect(toLayout({ ...defaultLayout, sideSectionsCollapsed: null }).sideSectionsCollapsed).toEqual([]);
  });

  it("should drop a side-section key the API would refuse when a served layout names one", () => {
    expect(toLayout({ ...defaultLayout, sideSectionsCollapsed: ["signals", "orders", "Ladder", 3] }).sideSectionsCollapsed).toEqual(["signals"]);
  });

  it("should collapse or open one side section and return the same layout when nothing changes", () => {
    const ladder = withSideSectionCollapsed(defaultLayout, "ladder", true);
    const both = withSideSectionCollapsed(ladder, "levels", true);

    expect(isSideSectionCollapsed(defaultLayout, "ladder")).toBe(false);
    expect(isSideSectionCollapsed(ladder, "ladder")).toBe(true);
    expect(isSideSectionCollapsed(ladder, "levels")).toBe(false);
    expect(both.sideSectionsCollapsed).toEqual(["ladder", "levels"]);
    expect(withSideSectionCollapsed(both, "ladder", false).sideSectionsCollapsed).toEqual(["levels"]);
    expect(withSideSectionCollapsed(both, "ladder", true)).toBe(both);
    expect(withSideSectionCollapsed(defaultLayout, "layers", false)).toBe(defaultLayout);
    expect(both.indicatorDockCollapsed).toBe(defaultLayout.indicatorDockCollapsed);
  });

  it("should put an inverted heat cutoff pair back in order when the layout is read", () => {
    const read = toLayout({ ...defaultLayout, heatLowPercentile: 90, heatHighPercentile: 10 });

    expect(read.heatLowPercentile).toBe(10);
    expect(read.heatHighPercentile).toBe(90);
    expect(orderedHeatCutoffs(40, 40)).toEqual({ heatLowPercentile: 5, heatHighPercentile: 95 });
  });
});

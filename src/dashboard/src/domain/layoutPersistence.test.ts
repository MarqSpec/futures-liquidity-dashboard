import { describe, expect, it } from "vitest";

import { defaultLayout } from "./layout.ts";
import { readStoredLayout, reconcileLayout, type ServerLayout, type StoredLayout } from "./layoutPersistence.ts";

const serverDefaults: ServerLayout = { saved: false, revision: 0, layout: defaultLayout };

function local(revision: number, instrument: string, pending = false): StoredLayout {
  return { revision, layout: { ...defaultLayout, instrument }, pending };
}

describe("reconcileLayout", () => {
  it("should push the local layout at the server revision when the server has never saved one", () => {
    const stored = local(1_700, "MGC");

    expect(reconcileLayout(stored, serverDefaults)).toEqual({
      layout: stored.layout,
      revision: 0,
      push: true,
    });
  });

  it("should push a legacy local layout when the server has never saved one", () => {
    const stored = local(0, "MGC");

    const choice = reconcileLayout(stored, serverDefaults);

    expect(choice.push).toBe(true);
    expect(choice.revision).toBe(0);
    expect(choice.layout.instrument).toBe("MGC");
  });

  it("should keep the server defaults when nothing was saved locally or on the server", () => {
    expect(reconcileLayout(null, serverDefaults)).toEqual({
      layout: defaultLayout,
      revision: 0,
      push: false,
    });
  });

  it("should adopt the server layout when the local copy is not an unsent edit", () => {
    const stored = local(2_000, "MCL");
    const server: ServerLayout = { saved: true, revision: 1, layout: { ...defaultLayout, instrument: "MES" } };

    expect(reconcileLayout(stored, server)).toEqual({ layout: server.layout, revision: 1, push: false });
  });

  it("should push an unsent local edit when it cites the server revision", () => {
    const stored = local(4, "MCL", true);
    const server: ServerLayout = { saved: true, revision: 4, layout: { ...defaultLayout, instrument: "MES" } };

    const choice = reconcileLayout(stored, server);

    expect(choice).toEqual({ layout: stored.layout, revision: 4, push: true });
  });

  it("should adopt the server layout when an unsent edit cites a different revision", () => {
    const stored = local(4, "MCL", true);
    const server: ServerLayout = { saved: true, revision: 5, layout: { ...defaultLayout, instrument: "MGC" } };

    expect(reconcileLayout(stored, server)).toEqual({ layout: server.layout, revision: 5, push: false });
  });
});

describe("readStoredLayout", () => {
  it("should read a revisioned document when one was stored", () => {
    const stored = readStoredLayout({ revision: 42, layout: { ...defaultLayout, historyMinutes: 60 }, pending: true });

    expect(stored?.revision).toBe(42);
    expect(stored?.layout.historyMinutes).toBe(60);
    expect(stored?.pending).toBe(true);
  });

  it("should read a legacy layout object as revision zero when the document has no revision", () => {
    const stored = readStoredLayout({ ...defaultLayout, instrument: "MGC" });

    expect(stored?.revision).toBe(0);
    expect(stored?.pending).toBe(false);
    expect(stored?.layout.instrument).toBe("MGC");
  });

  it("should fill omitted fields when the stored layout is otherwise valid", () => {
    const stored = readStoredLayout({ revision: 3, layout: { instrument: "MGC" } });

    expect(stored?.revision).toBe(3);
    expect(stored?.pending).toBe(false);
    expect(stored?.layout.instrument).toBe("MGC");
    expect(stored?.layout.historyMinutes).toBe(240);
    expect(stored?.layout.watchlist).toEqual(["MES", "MCL", "MGC"]);
    expect(stored?.layout.preset).toBe("standard");
    expect(stored?.layout.showVolumeDots).toBe(true);
    expect(stored?.layout.hideValueArea).toBe(false);
  });

  it("should accept the history and contrast boundaries when they are exactly at the limit", () => {
    const low = readStoredLayout({ revision: 1, layout: { ...defaultLayout, historyMinutes: 5, heatContrast: 0.1 } });
    const high = readStoredLayout({ revision: 1, layout: { ...defaultLayout, historyMinutes: 4320, heatContrast: 5 } });

    expect(low?.layout.historyMinutes).toBe(5);
    expect(low?.layout.heatContrast).toBe(0.1);
    expect(high?.layout.historyMinutes).toBe(4320);
    expect(high?.layout.heatContrast).toBe(5);
  });

  it("should return null when a field is just outside the schema", () => {
    expect(readStoredLayout({ revision: 1, layout: { ...defaultLayout, historyMinutes: 4 } })).toBeNull();
    expect(readStoredLayout({ revision: 1, layout: { ...defaultLayout, historyMinutes: 4321 } })).toBeNull();
    expect(readStoredLayout({ revision: 1, layout: { ...defaultLayout, heatContrast: 0.09 } })).toBeNull();
    expect(readStoredLayout({ revision: 1, layout: { ...defaultLayout, heatContrast: 5.01 } })).toBeNull();
  });

  it("should return null when the stored value is not an object", () => {
    expect(readStoredLayout(null)).toBeNull();
    expect(readStoredLayout("MES")).toBeNull();
  });

  it("should return null when a high revision wraps an invalid layout", () => {
    const corrupt = { revision: Number.MAX_SAFE_INTEGER, layout: { instrument: "not valid!!" } };

    expect(readStoredLayout(corrupt)).toBeNull();
  });

  it("should drop unknown pane and signal keys when the other fields are valid", () => {
    const stored = readStoredLayout({
      revision: 2,
      layout: { ...defaultLayout, instrument: "MGC", panes: { heatmap: false, bogus: true }, signals: { Spoof: false, Imaginary: true } },
    });

    expect(stored?.revision).toBe(2);
    expect(stored?.layout.instrument).toBe("MGC");
    expect(stored?.layout.panes).toEqual({ heatmap: false });
    expect(stored?.layout.signals).toEqual({ Spoof: false });
  });

  it("should keep a saved event dot size and refuse one the server would reject", () => {
    const { eventDotSize: _size, ...older } = defaultLayout;

    expect(readStoredLayout({ revision: 3, layout: older })?.layout.eventDotSize).toBe("medium");
    expect(readStoredLayout({ revision: 3, layout: { ...defaultLayout, eventDotSize: "small" } })?.layout.eventDotSize).toBe("small");
    expect(readStoredLayout({ revision: 3, layout: { ...defaultLayout, eventDotSize: "huge" } })).toBeNull();
    const { showPriceLine: _line, ...withoutLine } = defaultLayout;
    expect(readStoredLayout({ revision: 3, layout: withoutLine })?.layout.showPriceLine).toBe(true);
    expect(readStoredLayout({ revision: 3, layout: { ...defaultLayout, showPriceLine: false } })?.layout.showPriceLine).toBe(false);
    expect(readStoredLayout({ revision: 3, layout: { ...defaultLayout, centerPrice: null } })).toBeNull();
    expect(readStoredLayout({ revision: 3, layout: { ...defaultLayout, centerPrice: true } })?.layout.centerPrice).toBe(true);
  });

  it("should default a missing indicator pane and refuse an unknown one", () => {
    const { indicatorPane: _pane, ...older } = defaultLayout;

    expect(readStoredLayout({ revision: 4, layout: older })?.layout.indicatorPane).toBe("footprint");
    expect(readStoredLayout({ revision: 4, layout: { ...defaultLayout, indicatorPane: "macd" } })?.layout.indicatorPane).toBe("macd");
    expect(readStoredLayout({ revision: 4, layout: { ...defaultLayout, indicatorPane: "volume" } })).toBeNull();
  });

  it("should keep a saved collapsed dock and refuse a flag the server would reject", () => {
    const { indicatorDockCollapsed: _collapsed, ...older } = defaultLayout;

    expect(readStoredLayout({ revision: 5, layout: older })?.layout.indicatorDockCollapsed).toBe(false);
    expect(readStoredLayout({ revision: 5, layout: { ...defaultLayout, indicatorDockCollapsed: true } })?.layout.indicatorDockCollapsed).toBe(true);
    expect(readStoredLayout({ revision: 5, layout: { ...defaultLayout, indicatorDockCollapsed: null } })).toBeNull();
    expect(readStoredLayout({ revision: 5, layout: { ...defaultLayout, indicatorDockCollapsed: "true" } })).toBeNull();
  });

  it("should keep saved collapsed side sections and refuse a key the server would reject", () => {
    const { sideSectionsCollapsed: _collapsed, ...older } = defaultLayout;

    expect(readStoredLayout({ revision: 5, layout: older })?.layout.sideSectionsCollapsed).toEqual([]);
    expect(readStoredLayout({ revision: 5, layout: { ...defaultLayout, sideSectionsCollapsed: ["profile", "signals"] } })?.layout.sideSectionsCollapsed).toEqual([
      "signals",
      "profile",
    ]);
    expect(readStoredLayout({ revision: 5, layout: { ...defaultLayout, sideSectionsCollapsed: ["ladder", "orders"] } })).toBeNull();
    expect(readStoredLayout({ revision: 5, layout: { ...defaultLayout, sideSectionsCollapsed: ["Ladder"] } })).toBeNull();
    expect(readStoredLayout({ revision: 5, layout: { ...defaultLayout, sideSectionsCollapsed: null } })).toBeNull();
    expect(readStoredLayout({ revision: 5, layout: { ...defaultLayout, sideSectionsCollapsed: "ladder" } })).toBeNull();
  });

  it("should return null when a legacy object is not a layout", () => {
    expect(readStoredLayout({ instrument: "not valid!!" })).toBeNull();
    expect(readStoredLayout({ ...defaultLayout, panes: { heatmap: "yes" } })).toBeNull();
  });

  it("should return null when the revision cannot be compared exactly", () => {
    expect(readStoredLayout({ revision: Number.MAX_VALUE, layout: defaultLayout })).toBeNull();
    expect(readStoredLayout({ revision: 1.5, layout: defaultLayout })).toBeNull();
    expect(readStoredLayout({ revision: -1, layout: defaultLayout })).toBeNull();
  });
});

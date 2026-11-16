import { afterEach, describe, expect, it } from "vitest";

import { color } from "../design/tokens.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { canvasTheme } from "../theme.ts";
import { biasColors, countByKind, eventMarker, eventMarkers, eventsInWindow, visibleSignals } from "./signals.ts";

const signals = snapshotFixture().orderFlow.signals;

describe("visibleSignals", () => {
  it("should list the signals newest first when every kind is on", () => {
    const ids = visibleSignals(signals, () => true).map((s) => s.id);

    expect(ids).toEqual([...signals.map((s) => s.id)].reverse());
  });

  it("should hide a kind when its toggle is off", () => {
    const shown = visibleSignals(signals, (kind) => kind !== "Iceberg");

    expect(shown.some((s) => s.kind === "Iceberg")).toBe(false);
  });

  it("should keep the other kinds when one toggle is off", () => {
    expect(visibleSignals(signals, (kind) => kind !== "Iceberg")).toHaveLength(signals.length - 1);
  });

  it("should stop at the limit when one is given", () => {
    expect(visibleSignals(signals, () => true, 3)).toHaveLength(3);
  });
});

describe("eventMarker", () => {
  it("should draw spoof and trapped traders hollow, because both infer intent", () => {
    expect(eventMarker("Spoof").inferred).toBe(true);
    expect(eventMarker("TrappedTraders").inferred).toBe(true);
    expect(eventMarker("StackedImbalance").inferred).toBe(false);
  });

  it("should colour each kind from its own event token when the Terminal theme draws", () => {
    expect(eventMarkers.map((marker) => [marker.kind, marker.color])).toEqual([
      ["Iceberg", color("event-iceberg")],
      ["StackedImbalance", color("event-stacked-imbalance")],
      ["UnfinishedAuction", color("event-unfinished-auction")],
      ["TrappedTraders", color("event-trapped-traders")],
      ["CvdDivergence", color("event-cvd-divergence")],
      ["DeltaExhaustion", color("event-delta-exhaustion")],
      ["Spoof", color("event-spoof")],
      ["LiquiditySweep", color("event-liquidity-sweep")],
      ["SinglePrints", color("event-single-prints")],
      ["FailedReclaim", color("event-failed-reclaim")],
    ]);
  });

  it("should keep the hex the Order Flow canvas drew before the tokens, but a lighter liquidity sweep, when the theme is Terminal", () => {
    // FR-67: the per-kind palette stays. The one Terminal change is the liquidity sweep, #882255 → #C2477F, so its
    // ring holds 3:1 on the dark surfaces (the maintainer's ruling).
    expect(eventMarkers.map((marker) => marker.color.toUpperCase())).toEqual([
      "#56B4E9",
      "#E69F00",
      "#009E73",
      "#CC79A7",
      "#F0E442",
      "#D55E00",
      "#0072B2",
      "#C2477F",
      "#44AA99",
      "#AA4499",
    ]);
    expect(eventMarker("SomethingNew").color.toUpperCase()).toBe("#BDBDBD");
  });

  it("should colour a kind the server added later from event-unknown when it has no token of its own", () => {
    expect(eventMarker("SomethingNew")).toMatchObject({ kind: "SomethingNew", color: color("event-unknown"), inferred: false });
  });
});

describe("eventsInWindow", () => {
  const many = Array.from({ length: 50 }, (_, index) => ({
    timeMs: index * 60_000,
    kind: index % 2 === 0 ? "StackedImbalance" : "Iceberg",
  }));

  it("should keep every event in the window when there are more than the old cap of 40", () => {
    expect(eventsInWindow(many, () => true, 0, 49 * 60_000)).toHaveLength(50);
  });

  it("should bring an older event back when the window pans onto it", () => {
    const early = many[0];
    expect(eventsInWindow(many, () => true, 10 * 60_000, 49 * 60_000).some((signal) => signal.timeMs === early?.timeMs)).toBe(false);

    const panned = eventsInWindow(many, () => true, 0, 5 * 60_000);

    expect(panned.map((signal) => signal.timeMs)).toEqual([0, 60_000, 120_000, 180_000, 240_000, 300_000]);
  });

  it("should omit a kind that is switched off", () => {
    expect(eventsInWindow(many, (kind) => kind !== "Iceberg", 0, 49 * 60_000).every((signal) => signal.kind === "StackedImbalance")).toBe(true);
  });
});

describe("countByKind", () => {
  it("should count one per kind when the fixture holds one signal of each", () => {
    expect(countByKind(signals).get("Spoof")).toBe(1);
  });
});

describe("signal colours in Light", () => {
  afterEach(() => canvasTheme.set("dark"));

  it("should colour each event kind and an unknown kind from the Light token values when the Light theme draws", () => {
    canvasTheme.set("light");

    expect(eventMarkers.map((marker) => marker.color)).toEqual(eventMarkers.map((marker) => color(marker.token, "light")));
    expect(eventMarker("Spoof").color).toBe("#00508f");
    expect(eventMarker("SomethingNew").color).toBe(color("event-unknown", "light"));
  });

  it("should colour each bias from the Light token values when the Light theme draws", () => {
    canvasTheme.set("light");

    expect({ ...biasColors }).toEqual({
      Bullish: color("bias-bullish", "light"),
      Bearish: color("bias-bearish", "light"),
      Neutral: color("bias-neutral", "light"),
    });
  });
});

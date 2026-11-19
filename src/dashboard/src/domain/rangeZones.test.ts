import { describe, expect, it } from "vitest";

import { deltaSchema, snapshotSchema, type RangeZoneSet } from "../api/schemas.ts";
import { deltaFixture, rawDelta, rawSnapshot, snapshotFixture } from "../test/fixtures.ts";
import { acceptStoredLayout, defaultLayout, isPaneOn, toLayout, withPane } from "./layout.ts";
import { applyDelta, fromSnapshot } from "./merge.ts";
import { rangeZonesFor } from "./rangeZones.ts";

// reference: REQUIREMENTS.md FR-75, FR-9 (INTERFACES.md D.2)

const fifteen = { startMs: 1_000, endMs: 2_800_000, lowTicks: 100, highTicks: 120 };
const five = { startMs: 4_000, endMs: 904_000, lowTicks: 101, highTicks: 110 };
const sets: RangeZoneSet[] = [
  { timeframeSeconds: 300, zones: [five] },
  { timeframeSeconds: 900, zones: [fifteen] },
];

describe("range zones on the wire", () => {
  it("should read every timeframe's zones when the snapshot carries them", () => {
    const parsed = snapshotSchema.parse({ ...(rawSnapshot as object), rangeZones: sets });

    expect(parsed.rangeZones).toEqual(sets);
  });

  it("should read no zones when an older server's snapshot omits them", () => {
    expect(snapshotSchema.parse(rawSnapshot).rangeZones).toEqual([]);
  });

  it("should read a delta without zones as unchanged, not as empty", () => {
    expect(deltaSchema.parse(rawDelta).rangeZones).toBeNull();
    expect(deltaSchema.parse({ ...(rawDelta as object), rangeZones: [] }).rangeZones).toEqual([]);
  });

  it("should reject the snapshot when a zone is missing a bound", () => {
    const broken = { ...(rawSnapshot as object), rangeZones: [{ timeframeSeconds: 900, zones: [{ startMs: 1, endMs: 2, lowTicks: 3 }] }] };

    expect(snapshotSchema.safeParse(broken).success).toBe(false);
  });
});

describe("range zones in the market state", () => {
  const snapshot = { ...snapshotFixture(), rangeZones: sets };

  it("should keep the snapshot's zones when the state is built", () => {
    expect(fromSnapshot(snapshot, 5, 0).rangeZones).toEqual(sets);
  });

  it("should keep the zones it holds when a delta carries none", () => {
    const state = fromSnapshot(snapshot, 5, 0);

    const next = applyDelta(state, deltaFixture({ seq: snapshot.seq + 1, rangeZones: null }), 1);

    expect(next.rangeZones).toBe(state.rangeZones);
  });

  it("should replace the zones when a delta carries them", () => {
    const state = fromSnapshot(snapshot, 5, 0);
    const grown: RangeZoneSet[] = [{ timeframeSeconds: 900, zones: [{ ...fifteen, endMs: 3_700_000 }] }];

    const next = applyDelta(state, deltaFixture({ seq: snapshot.seq + 1, rangeZones: grown }), 1);

    expect(next.rangeZones).toEqual(grown);
  });
});

describe("rangeZoneTimeframe", () => {
  it("should default to five-minute bars when the layout omits it", () => {
    expect(defaultLayout.rangeZoneTimeframe).toBe("300");
    expect(toLayout({}).rangeZoneTimeframe).toBe("300");
  });

  it("should keep 900 and off when the layout names them", () => {
    expect(toLayout({ rangeZoneTimeframe: "900" }).rangeZoneTimeframe).toBe("900");
    expect(toLayout({ rangeZoneTimeframe: "off" }).rangeZoneTimeframe).toBe("off");
  });

  it("should read a served value it does not know as the default", () => {
    expect(toLayout({ rangeZoneTimeframe: "60" }).rangeZoneTimeframe).toBe("300");
    expect(toLayout({ rangeZoneTimeframe: 900 }).rangeZoneTimeframe).toBe("300");
  });

  it("should refuse a stored layout whose value is unknown, and default one that omits it", () => {
    expect(acceptStoredLayout({ ...defaultLayout, rangeZoneTimeframe: "1800" })).toBeNull();
    const { rangeZoneTimeframe: _omitted, ...older } = defaultLayout;
    expect(acceptStoredLayout(older)?.rangeZoneTimeframe).toBe("300");
    expect(acceptStoredLayout({ ...defaultLayout, rangeZoneTimeframe: "off" })?.rangeZoneTimeframe).toBe("off");
  });

  it("should show the Range zones layer until the viewer turns it off", () => {
    expect(isPaneOn(defaultLayout, "range-zones")).toBe(true);
    expect(isPaneOn(withPane(defaultLayout, "range-zones", false), "range-zones")).toBe(false);
    expect(toLayout({ panes: { "range-zones": false } }).panes).toEqual({ "range-zones": false });
  });
});

describe("rangeZonesFor", () => {
  it("should give the zones of the layout's timeframe", () => {
    expect(rangeZonesFor(sets, defaultLayout)).toEqual([five]);
    expect(rangeZonesFor(sets, { ...defaultLayout, rangeZoneTimeframe: "900" })).toEqual([fifteen]);
  });

  it("should give none when the timeframe is off or the layer is toggled off", () => {
    expect(rangeZonesFor(sets, { ...defaultLayout, rangeZoneTimeframe: "off" })).toEqual([]);
    expect(rangeZonesFor(sets, withPane(defaultLayout, "range-zones", false))).toEqual([]);
  });

  it("should give none when the server sends no set for the timeframe", () => {
    expect(rangeZonesFor([{ timeframeSeconds: 900, zones: [fifteen] }], defaultLayout)).toEqual([]);
  });
});

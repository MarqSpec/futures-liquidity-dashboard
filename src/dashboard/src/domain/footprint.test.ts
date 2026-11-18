import { describe, expect, it } from "vitest";

import { snapshotFixture } from "../test/fixtures.ts";
import { barOverlapsMissing } from "../components/drawFootprint.ts";
import { decodeFootprint, footprintPoc } from "./footprint.ts";

const bar = (c: number[]) => ({ t: 0, d: 60_000, v: 0, delta: 0, maxDelta: 0, minDelta: 0, c });

describe("decodeFootprint", () => {
  it("should decode cells highest price first when given a flat array", () => {
    const cells = decodeFootprint(bar([100, 4, 1, 0, 101, 0, 9, 1, 99, 7, 0, -1]));

    expect(cells.map((c) => c.priceTicks)).toEqual([101, 100, 99]);
  });

  it("should keep the imbalance flag when a cell is a buy imbalance", () => {
    expect(decodeFootprint(bar([101, 0, 9, 1]))[0]?.imbalance).toBe(1);
  });

  it("should keep the imbalance flag when a cell is a sell imbalance", () => {
    expect(decodeFootprint(bar([99, 7, 0, -1]))[0]?.imbalance).toBe(-1);
  });

  it("should decode the captured footprint when it is real", () => {
    const footprint = snapshotFixture().orderFlow.footprints[0];

    expect(footprint && decodeFootprint(footprint).length).toBe(4);
  });
});

describe("footprintPoc", () => {
  it("should pick the price with the most volume when one stands out", () => {
    expect(footprintPoc(decodeFootprint(bar([100, 4, 1, 0, 101, 0, 9, 1, 99, 7, 0, -1])))).toBe(101);
  });

  it("should pick the lower price when two prices tie", () => {
    expect(footprintPoc(decodeFootprint(bar([100, 5, 0, 0, 101, 0, 5, 0])))).toBe(100);
  });

  it("should return null when the bar is empty", () => {
    expect(footprintPoc([])).toBeNull();
  });
});

describe("barOverlapsMissing", () => {
  it("should flag the bar that contains the drop and keep it after the gap closes", () => {
    expect(barOverlapsMissing(0, 60_000, [[30_000, null]])).toBe(true);
    expect(barOverlapsMissing(0, 60_000, [[90_000, null]])).toBe(false);
    expect(barOverlapsMissing(120_000, 60_000, [[30_000, 100_000]])).toBe(false);
    expect(barOverlapsMissing(60_000, 60_000, [[30_000, 100_000]])).toBe(true);
    expect(barOverlapsMissing(100_000, 60_000, [[30_000, 100_000]])).toBe(false);
  });
});

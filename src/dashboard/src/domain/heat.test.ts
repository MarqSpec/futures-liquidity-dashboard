import { describe, expect, it } from "vitest";

import { snapshotFixture } from "../test/fixtures.ts";
import { aggregateHeat, decodeHeatColumn, firstColumnEndingAfter, heatScale, logIntensity } from "./heat.ts";

describe("firstColumnEndingAfter", () => {
  const columns = [0, 1, 2].map((index) => ({ t: index * 60_000, d: 60_000, c: [1] }));

  it("should return the first column that ends after the instant when columns are in time order", () => {
    expect(firstColumnEndingAfter(columns, 60_000)).toBe(1);
    expect(firstColumnEndingAfter(columns, 60_001)).toBe(1);
    expect(firstColumnEndingAfter(columns, 120_000)).toBe(2);
  });

  it("should return the length when every column ends at or before the instant", () => {
    expect(firstColumnEndingAfter(columns, 180_000)).toBe(3);
    expect(firstColumnEndingAfter([], 0)).toBe(0);
  });
});

describe("decodeHeatColumn", () => {
  it("should decode one cell per four numbers when given a flat column", () => {
    const cells = decodeHeatColumn({ t: 0, d: 1000, c: [100, 5, 0, 1000, 101, 0, 7, 500] });

    expect(cells).toEqual([
      { priceTicks: 100, bid: 5, ask: 0, knownMs: 1000, unknownFraction: 0 },
      { priceTicks: 101, bid: 0, ask: 7, knownMs: 500, unknownFraction: 0.5 },
    ]);
  });

  it("should mark a cell as partly unknown when knownMs is less than the slice", () => {
    const delta = { t: 0, d: 1000, c: [27049, 328, 0, 708] };

    expect(decodeHeatColumn(delta)[0]?.unknownFraction).toBeCloseTo(0.292);
  });

  it("should decode every cell of the captured snapshot when its columns are real", () => {
    const column = snapshotFixture().heat[0];

    expect(column && decodeHeatColumn(column).length).toBe((column?.c.length ?? 0) / 4);
  });
});

describe("logIntensity", () => {
  it("should map the window maximum to 1 and a zero quantity to 0", () => {
    expect(logIntensity(0, 100)).toBe(0);
    expect(logIntensity(100, 100)).toBe(1);
  });

  it("should compress a large wall when the scale is logarithmic", () => {
    const small = logIntensity(10, 1000);
    expect(logIntensity(1000, 1000)).toBe(1);
    expect(small).toBeGreaterThan(10 / 1000);
    expect(small).toBeLessThan(0.5);
  });
});

describe("aggregateHeat", () => {
  it("should weight the means by known time when two slices share a bucket", () => {
    const columns = aggregateHeat(
      [
        { t: 0, d: 60_000, c: [100, 10, 0, 60_000] },
        { t: 60_000, d: 60_000, c: [100, 30, 0, 60_000] },
      ],
      120_000,
    );

    expect(columns).toHaveLength(1);
    expect(columns[0]?.t).toBe(0);
    expect(columns[0]?.d).toBe(120_000);
    expect(columns[0]?.c[1]).toBeCloseTo(20);
    expect(columns[0]?.c[3]).toBe(120_000);
  });
});

describe("heatScale", () => {
  it("should return 1 when no column holds any liquidity", () => {
    expect(heatScale([{ t: 0, d: 1000, c: [100, 0, 0, 1000] }])).toBe(1);
  });

  it("should not let one outlier set the scale when the quantile is below 1", () => {
    const c = Array.from({ length: 100 }, (_, i) => [i, 10, 0, 1000]).flat();
    c.push(500, 100_000, 0, 1000);

    expect(heatScale([{ t: 0, d: 1000, c }], 0.9)).toBe(10);
  });
});

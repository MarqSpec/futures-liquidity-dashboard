import { describe, expect, it } from "vitest";

import { instrumentSummaryFixture, instrumentsFixture } from "../test/fixtures.ts";
import { formatArrowed, formatSignalAge, nextSort, overviewRow, sortedOverview, sortOverview } from "./overview.ts";

const rows = instrumentsFixture().map(overviewRow);
const roots = (list: readonly { readonly instrument: { readonly root: string } }[]) => list.map((r) => r.instrument.root);

describe("overviewRow", () => {
  it("should take the 5- and 15-minute regimes by timeframe when the server publishes both", () => {
    const es = rows.find((r) => r.instrument.root === "ES");

    expect([es?.regime5m?.trend, es?.regime15m?.trend, es?.agreement]).toEqual(["TrendingUp", "TrendingUp", "agree"]);
  });

  it("should mark a conflict when 5m ranges while 15m trends", () => {
    expect(rows.find((r) => r.instrument.root === "CL")?.agreement).toBe("conflict");
  });

  it("should have no regime when the server publishes none", () => {
    expect(overviewRow(instrumentSummaryFixture()).regime5m).toBeNull();
  });
});

describe("sortOverview", () => {
  it("should sort by session volume, largest first, when sorted descending", () => {
    expect(roots(sortOverview(rows, "volume", "descending"))).toEqual(["ES", "CL", "GC"]);
  });

  it("should sort by change as a share of the open, with an unknown change last either way", () => {
    expect([roots(sortOverview(rows, "change", "ascending")), roots(sortOverview(rows, "change", "descending"))]).toEqual([
      ["CL", "ES", "GC"],
      ["ES", "CL", "GC"],
    ]);
  });

  it("should put a missing spread last when sorting ascending", () => {
    expect(roots(sortOverview(rows, "spread", "ascending")).at(-1)).toBe("GC");
  });

  it("should order the 5-minute regime up, down, range, unclear, warming", () => {
    expect(roots(sortOverview(rows, "regime5m", "ascending"))).toEqual(["ES", "CL", "GC"]);
  });

  it("should sort by root when sorted by product", () => {
    expect(roots(sortOverview(rows, "product", "descending"))).toEqual(["GC", "ES", "CL"]);
  });

  it("should list the newest signal first when sorting by signal descending", () => {
    expect(roots(sortOverview(rows, "signal", "descending"))[0]).toBe("ES");
  });
});

describe("sortedOverview", () => {
  it("should keep only the products the filter matches", () => {
    expect(roots(sortedOverview(instrumentsFixture(), "crude", "product", "ascending"))).toEqual(["CL"]);
  });
});

describe("nextSort", () => {
  it("should sort a new column ascending, then descending, then go back to grouped", () => {
    const first = nextSort(null, "cvd");
    const second = nextSort(first, "cvd");

    expect([first, second, nextSort(second, "cvd")]).toEqual([
      { key: "cvd", direction: "ascending" },
      { key: "cvd", direction: "descending" },
      null,
    ]);
  });

  it("should start ascending when another column is clicked", () => {
    expect(nextSort({ key: "cvd", direction: "descending" }, "volume")).toEqual({ key: "volume", direction: "ascending" });
  });
});

describe("formatArrowed", () => {
  it("should carry the arrow of the direction with the signed value", () => {
    expect([formatArrowed(1200), formatArrowed(-300), formatArrowed(0)]).toEqual(["↑ +1,200", "↓ −300", "→ 0"]);
  });
});

describe("formatSignalAge", () => {
  it("should round a signal under a minute old down to less than a minute", () => {
    expect([formatSignalAge(12_000), formatSignalAge(240_000)]).toEqual(["<1 min", "4 min"]);
  });
});

import { describe, expect, it } from "vitest";

import { instrumentSummaryFixture } from "../test/fixtures.ts";
import {
  formatPercentChange,
  formatPriceChange,
  formatSpread,
  groupProducts,
  matchesFilter,
  productRow,
  watchlistTitle,
} from "./products.ts";

const es = instrumentSummaryFixture(
  { root: "ES", sector: "Equity index" },
  { last: 27_100, sessionOpen: 27_000, bid: 27_099, ask: 27_100, sessionVolume: 123_456, cumulativeDelta: -2_500 },
);
const nq = instrumentSummaryFixture({ root: "NQ", name: "E-mini Nasdaq-100", sector: "Equity index" });
const cl = instrumentSummaryFixture({ root: "CL", name: "Crude Oil", sector: "Energy", tickSize: 0.01 });
const gc = instrumentSummaryFixture({ root: "GC", name: "Gold", sector: "Metals", tickSize: 0.1, priceDecimals: 1 });
const btc = instrumentSummaryFixture({ root: "MBT", name: "Micro Bitcoin", sector: "Crypto" });
const odd = instrumentSummaryFixture({ root: "XX", name: "Something new", sector: "Weather" });
const all = [btc, odd, cl, es, gc, nq];

describe("productRow", () => {
  it("should format the last price from ticks with the instrument's tick size when it is known", () => {
    expect(productRow(es).last).toBe("6775.00");
  });

  it("should show the change from the session open as a price when both are known", () => {
    expect([productRow(es).change, productRow(es).changePercent]).toEqual(["+25.00", "+0.37 %"]);
  });

  it("should show a dash for the change when nothing has traded yet", () => {
    expect([productRow(nq).last, productRow(nq).change, productRow(nq).changeDirection]).toEqual(["—", "—", "none"]);
  });

  it("should carry the CVD with its sign and direction when it is negative", () => {
    expect([productRow(es).cvd, productRow(es).cvdDirection]).toEqual(["−2,500", "down"]);
  });

  it("should hide the CVD direction when the anchor was reset", () => {
    const dropped = instrumentSummaryFixture(
      { root: "ES", sector: "Equity index" },
      { last: 27_100, sessionOpen: 27_000, cumulativeDelta: -2_500 },
      { cvdKnown: false },
    );

    expect([productRow(dropped).cvd, productRow(dropped).cvdDirection]).toEqual(["unknown", "none"]);
  });

  it("should mark the row as holding depth when the server receives it", () => {
    expect(productRow(instrumentSummaryFixture({}, {}, { depthSubscribed: false })).depth).toBe(false);
  });

  it("should take the chip tone from the status code when the feed is live", () => {
    expect(productRow(instrumentSummaryFixture({}, {}, { code: "LIVE" })).tone).toBe("live");
  });
});

describe("formatPriceChange", () => {
  it("should use the instrument's decimals when the change is negative", () => {
    expect(formatPriceChange(-3, { tickSize: 0.1, priceDecimals: 1 })).toBe("−0.3");
  });

  it("should print no sign when nothing changed", () => {
    expect(formatPriceChange(0, { tickSize: 0.25, priceDecimals: 2 })).toBe("0.00");
  });
});

describe("formatPercentChange", () => {
  it("should be a dash when the session open is unknown", () => {
    expect(formatPercentChange(4, null)).toBe("—");
  });

  it("should drop the sign when the change rounds to zero", () => {
    expect(formatPercentChange(-1, 1_000_000)).toBe("0.00 %");
  });
});

describe("formatSpread", () => {
  it("should be the ticks between bid and ask when both are known", () => {
    expect(formatSpread({ ...es.summary, bid: 100, ask: 102 })).toBe("2");
  });

  it("should be a dash when the book is crossed", () => {
    expect(formatSpread({ ...es.summary, bid: 102, ask: 100 })).toBe("—");
  });
});

describe("matchesFilter", () => {
  it("should match the root ignoring case when the filter is part of it", () => {
    expect(matchesFilter(es.instrument, " es ")).toBe(true);
  });

  it("should match the name when the filter is a word in it", () => {
    expect(matchesFilter(cl.instrument, "crude")).toBe(true);
  });

  it("should not match when neither the root nor the name holds the text", () => {
    expect(matchesFilter(gc.instrument, "oil")).toBe(false);
  });
});

describe("groupProducts", () => {
  it("should list the watchlist first in its own order when products are watched", () => {
    const groups = groupProducts(all, ["GC", "ES"], "");

    expect([groups[0]?.title, groups[0]?.rows.map((r) => r.root)]).toEqual([watchlistTitle, ["GC", "ES"]]);
  });

  it("should order the other sectors by the sector order, with unknown sectors last", () => {
    const titles = groupProducts(all, ["GC"], "").map((g) => g.title);

    expect(titles).toEqual([watchlistTitle, "Equity index", "Energy", "Crypto", "Weather"]);
  });

  it("should not list a watched product again under its sector", () => {
    const equity = groupProducts(all, ["ES"], "").find((g) => g.title === "Equity index");

    expect(equity?.rows.map((r) => r.root)).toEqual(["NQ"]);
  });

  it("should drop a group the filter empties", () => {
    expect(groupProducts(all, ["ES"], "gold").map((g) => g.title)).toEqual(["Metals"]);
  });

  it("should leave out a watched root the API does not list", () => {
    expect(groupProducts([es], ["ZZ", "ES"], "")[0]?.rows.map((r) => r.root)).toEqual(["ES"]);
  });

  it("should have no watchlist group when nothing is watched", () => {
    expect(groupProducts(all, [], "").map((g) => g.title)).not.toContain(watchlistTitle);
  });
});

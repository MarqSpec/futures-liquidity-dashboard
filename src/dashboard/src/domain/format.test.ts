import { describe, expect, it } from "vitest";

import { formatAge, formatChicagoTime, formatQty, formatPercent, formatSigned, formatTicks, priceToTicks, ticksToPrice, wholePercent } from "./format.ts";

const es = { tickSize: 0.25, priceDecimals: 2 };
const gc = { tickSize: 0.1, priceDecimals: 1 };
const cl = { tickSize: 0.01, priceDecimals: 2 };

describe("ticksToPrice", () => {
  it("should multiply by the tick size when the instrument is ES", () => {
    expect(ticksToPrice(27410, es)).toBe(6852.5);
  });

  it("should round away floating-point noise when the tick size is 0.1", () => {
    expect(ticksToPrice(40073, gc)).toBe(4007.3);
  });
});

describe("priceToTicks", () => {
  it("should round to the nearest tick when the price is between ticks", () => {
    expect(priceToTicks(6852.6, es)).toBe(27410);
  });

  it("should invert ticksToPrice when the instrument is CL", () => {
    expect(priceToTicks(ticksToPrice(5938, cl), cl)).toBe(5938);
  });
});

describe("formatTicks", () => {
  it("should print the instrument's decimals when the price is whole", () => {
    expect(formatTicks(27400, es)).toBe("6850.00");
  });

  it("should print one decimal when the instrument is GC", () => {
    expect(formatTicks(40073, gc)).toBe("4007.3");
  });

  it("should print a dash when the value is missing", () => {
    expect(formatTicks(null, es)).toBe("—");
  });
});

describe("formatSigned", () => {
  it("should prefix a plus when the value is positive", () => {
    expect(formatSigned(1682)).toBe("+1,682");
  });

  it("should prefix a minus sign when the value is negative", () => {
    expect(formatSigned(-15)).toBe("−15");
  });
});

describe("formatChicagoTime", () => {
  it("should show Chicago time when given a UTC instant", () => {
    // 2026-11-09 14:30:00 UTC is 08:30:00 CST (UTC−6).
    expect(formatChicagoTime(Date.UTC(2026, 10, 9, 14, 30, 0))).toBe("08:30:00 CT");
  });
});

describe("formatAge", () => {
  it("should show seconds when the age is under a minute", () => {
    expect(formatAge(4200)).toBe("4.2 s");
  });
});

// — a floor compares the percent the row shows
describe("wholePercent", () => {
  it("should round a half percent up, as the shown percent does", () => {
    expect(wholePercent(0.395)).toBe(40);
    expect(formatPercent(0.395)).toBe("40 %");
  });

  it("should round below a half percent down", () => {
    expect(wholePercent(0.394)).toBe(39);
  });
});

describe("formatQty", () => {
  // Pinned from the toLocaleString implementation it replaced, so the shared formatter is byte-identical.
  const table: readonly (readonly [number | null | undefined, string])[] = [
    [0, "0"],
    [-0, "-0"],
    [0.4, "0"],
    [0.5, "1"],
    [-0.5, "-0"],
    [-0.4, "-0"],
    [1, "1"],
    [-1, "-1"],
    [7.5, "8"],
    [-7.5, "-7"],
    [999, "999"],
    [1234, "1,234"],
    [1234.5, "1,235"],
    [-1234.5, "-1,234"],
    [9999.4, "9,999"],
    [9999.5, "10,000"],
    [-9999.5, "-9,999"],
    [10000, "10.0k"],
    [-10000, "-10.0k"],
    [12345, "12.3k"],
    [999999.99, "1000.0k"],
    [1_000_000, "1.00M"],
    [-2_500_000, "-2.50M"],
    [1_234_567.89, "1.23M"],
    [Number.NaN, "—"],
    [Number.POSITIVE_INFINITY, "—"],
    [null, "—"],
    [undefined, "—"],
  ];

  it.each(table)("should print %s as %s when the value is in the pinned table", (value, expected) => {
    expect(formatQty(value)).toBe(expected);
  });
});

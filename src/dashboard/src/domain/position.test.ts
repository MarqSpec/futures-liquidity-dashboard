import { describe, expect, it } from "vitest";

import { acceptStoredLayout, defaultLayout, toLayout } from "./layout.ts";
import { positionSchema, positionsSchema } from "./position.ts";

// reference: REQUIREMENTS.md FR-72, FR-9; ARCHITECTURE.md D-57

const long = {
  side: "long",
  entryType: "limit",
  entryTicks: 20000,
  quantity: 3,
  stopTicks: 19990,
  targets: [
    { priceTicks: 20010, quantity: 1 },
    { priceTicks: 20020, quantity: 2 },
  ],
  contractId: "MESZ26",
  createdMs: 1760000000000,
  state: "planned",
  fill: null,
  exits: [],
};

const market = { side: "short", entryType: "market", quantity: 1, stopTicks: 1, targets: [], contractId: "MCLF27", createdMs: 1 };

function refused(change: Record<string, unknown>): string[] {
  const result = positionSchema.safeParse({ ...long, ...change });
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
}

describe("positionSchema", () => {
  it("should accept a valid long and a market short when they are served", () => {
    expect(positionSchema.safeParse(long).success).toBe(true);
    const parsed = positionSchema.parse(market);
    expect(parsed.state).toBe("planned");
    expect(parsed.exits).toEqual([]);
  });

  it("should name the field when the stop is on the wrong side", () => {
    expect(refused({ stopTicks: 20001 })).toContain("stopTicks");
    expect(refused({ stopTicks: 20000 })).toContain("stopTicks");
    expect(positionSchema.safeParse({ ...long, side: "short", stopTicks: 20010, targets: [{ priceTicks: 19990, quantity: 1 }] }).success).toBe(true);
    expect(refused({ side: "short" })).toContain("stopTicks");
  });

  it("should name the field when a target is on the wrong side", () => {
    expect(refused({ targets: [{ priceTicks: 19999, quantity: 1 }] })).toContain("targets.0.priceTicks");
    expect(refused({ targets: [{ priceTicks: 20000, quantity: 1 }] })).toContain("targets.0.priceTicks");
  });

  it("should name the field when a price is off the tick grid", () => {
    expect(refused({ entryTicks: 20000.5 })).toContain("entryTicks");
    expect(refused({ stopTicks: 19990.5 })).toContain("stopTicks");
    expect(refused({ targets: [{ priceTicks: 20010.25, quantity: 1 }] })).toContain("targets.0.priceTicks");
  });

  it("should refuse a quantity outside 1 to 100 and accept the edges", () => {
    expect(refused({ quantity: 0 })).toContain("quantity");
    expect(refused({ quantity: 101 })).toContain("quantity");
    expect(refused({ quantity: 100 })).toEqual([]);
    expect(refused({ quantity: 1, targets: [] })).toEqual([]);
  });

  it("should refuse target quantities over the position quantity and a fourth target", () => {
    expect(
      refused({
        targets: [
          { priceTicks: 20010, quantity: 2 },
          { priceTicks: 20020, quantity: 2 },
        ],
      }),
    ).toContain("targets");
    const four = [20010, 20011, 20012, 20013].map((priceTicks) => ({ priceTicks, quantity: 1 }));
    expect(refused({ quantity: 10, targets: four })).toContain("targets");
    expect(refused({ quantity: 10, targets: four.slice(0, 3) })).toEqual([]);
  });

  it("should require targets beyond the stop when a market entry has no price", () => {
    const marketLong = { ...market, side: "long", quantity: 2, stopTicks: 20010 };
    const withTarget = (priceTicks: number, extra: Record<string, unknown> = marketLong) => positionSchema.safeParse({ ...extra, targets: [{ priceTicks, quantity: 1 }] });
    expect(withTarget(20020).success).toBe(true);
    expect(withTarget(20010).success).toBe(false);
    expect(withTarget(19990).success).toBe(false);
    const marketShort = { ...marketLong, side: "short" };
    expect(withTarget(20000, marketShort).success).toBe(true);
    expect(withTarget(20010, marketShort).success).toBe(false);
    expect(withTarget(20020, marketShort).success).toBe(false);
  });

  it("should match the server on a blank contract id and on omitted targets", () => {
    expect(refused({ contractId: "   " })).toContain("contractId");
    expect(refused({ contractId: "" })).toContain("contractId");
    expect(refused({ contractId: "X".repeat(33) })).toContain("contractId");
    const omitted: Record<string, unknown> = { ...long };
    delete omitted["targets"];
    expect(positionSchema.parse(omitted).targets).toEqual([]);
  });

  it("should require the entry price for a limit", () => {
    expect(refused({ entryTicks: null })).toContain("entryTicks");
  });

  it("should refuse tracking fields that contradict the state", () => {
    const fill = { timeMs: 1, priceTicks: 20000 };
    const exit = { timeMs: 2, priceTicks: 20010, quantity: 1, kind: "target" };
    expect(refused({ state: "filled" })).toContain("fill");
    expect(refused({ fill })).toContain("fill");
    expect(refused({ state: "working", exits: [exit] })).toContain("exits");
    expect(refused({ state: "filled", fill, exits: [{ ...exit, quantity: 4 }] })).toContain("exits");
    expect(refused({ state: "filled", fill, exits: [{ ...exit, kind: "hope" }] })).toContain("exits.0.kind");
    expect(refused({ state: "closed", fill, exits: [{ ...exit, quantity: 3 }] })).toEqual([]);
  });
});

describe("positionSchema tick bound", () => {
  const bound = 1_000_000_000;

  it("should accept every price at the bound, negative included, and refuse one tick past it", () => {
    expect(positionSchema.safeParse({ ...long, entryTicks: bound, stopTicks: -bound, targets: [] }).success).toBe(true);
    expect(refused({ entryTicks: bound + 1, stopTicks: 1 })).toContain("entryTicks");
    expect(refused({ stopTicks: -bound - 1 })).toContain("stopTicks");
    expect(refused({ targets: [{ priceTicks: bound + 1, quantity: 1 }] })).toContain("targets.0.priceTicks");
  });

  it("should bound the fill and the exits too", () => {
    const filled = { state: "filled", fill: { timeMs: 5, priceTicks: bound + 1 } };
    expect(refused(filled)).toContain("fill.priceTicks");
    const exit = { state: "closed", fill: { timeMs: 5, priceTicks: 20000 }, exits: [{ timeMs: 6, priceTicks: -bound - 1, quantity: 3, kind: "stop" }] };
    expect(refused(exit)).toContain("exits.0.priceTicks");
  });
});

describe("positionSchema fill risk basis", () => {
  const filled = { state: "filled", fill: { timeMs: 5, priceTicks: 20000 } };

  it("should accept a positive whole risk basis within the bound, and none", () => {
    expect(positionSchema.safeParse({ ...long, ...filled, fill: { ...filled.fill, riskTicks: 10 } }).success).toBe(true);
    expect(positionSchema.safeParse({ ...long, ...filled, fill: { ...filled.fill, riskTicks: 1_000_000_000 } }).success).toBe(true);
    expect(positionSchema.safeParse({ ...long, ...filled }).success).toBe(true);
    expect(positionSchema.safeParse({ ...long, ...filled, fill: { ...filled.fill, riskTicks: null } }).success).toBe(true);
  });

  it("should refuse zero, a negative, a fraction and one past the bound", () => {
    for (const riskTicks of [0, -1, 2.5, 1_000_000_001]) {
      expect(refused({ ...filled, fill: { ...filled.fill, riskTicks } })).toContain("fill.riskTicks");
    }
  });
});

describe("positionsSchema", () => {
  it("should keep the valid positions and drop an invalid one when the map is read leniently", () => {
    expect(Object.keys(positionsSchema.parse({ MES: long, MCL: { ...long, quantity: 0 }, "bad!": long }))).toEqual(["MES"]);
  });
});

describe("layout positions", () => {
  it("should default to none and read a served layout with positions", () => {
    expect(defaultLayout.positions).toEqual({});
    expect(toLayout({ ...defaultLayout, positions: { MES: long } }).positions.MES?.quantity).toBe(3);
    expect(toLayout({ ...defaultLayout, positions: "nope" }).positions).toEqual({});
  });

  it("should reject a stored layout whose position is invalid, and default when it is omitted", () => {
    expect(acceptStoredLayout({ ...defaultLayout, positions: { MES: { ...long, quantity: 101 } } })).toBeNull();
    expect(acceptStoredLayout({ ...defaultLayout, positions: { MES: long } })?.positions.MES?.side).toBe("long");
    const older: Record<string, unknown> = { ...defaultLayout };
    delete older["positions"];
    expect(acceptStoredLayout(older)?.positions).toEqual({});
  });
});

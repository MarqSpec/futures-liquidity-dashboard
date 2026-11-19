import { describe, expect, it } from "vitest";

import { positionSchema, type Position } from "./position.ts";
import { trackPrint } from "./positionTrack.ts";
import {
  addTarget,
  defaultStopDistance,
  moveLine,
  placePosition,
  positionLines,
  removeTarget,
  withEntryType,
  withQuantity,
  withSide,
  withTargetQuantity,
  checkPosition,
} from "./positionEdit.ts";

// reference: REQUIREMENTS.md FR-72, UC-20; ARCHITECTURE.md D-58

const long: Position = positionSchema.parse({
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
});

const marketShort: Position = positionSchema.parse({
  side: "short",
  entryType: "market",
  entryTicks: null,
  quantity: 2,
  stopTicks: 20010,
  targets: [{ priceTicks: 19990, quantity: 1 }],
  contractId: "MESZ26",
  createdMs: 1760000000000,
});

function placed(priceTicks: number, lastTicks: number | null): Position {
  return placePosition({ priceTicks, lastTicks, spanTicks: 200, contractId: "MESZ26", nowMs: 1760000000123 });
}

function moved(edit: ReturnType<typeof moveLine>): Position {
  if (!edit.ok) throw new Error(`refused: ${edit.reason}`);
  return edit.position;
}

describe("placePosition", () => {
  it("should place a long limit at the clicked tick when the click is below the last price", () => {
    const position = placed(19950, 20000);

    expect(position.side).toBe("long");
    expect(position.entryType).toBe("limit");
    expect(position.entryTicks).toBe(19950);
    expect(position.stopTicks).toBeLessThan(19950);
    expect(position.targets.every((target) => target.priceTicks > 19950)).toBe(true);
    expect(positionSchema.safeParse(position).success).toBe(true);
  });

  it("should place a short limit when the click is above the last price", () => {
    const position = placed(20001, 20000);

    expect(position.side).toBe("short");
    expect(position.stopTicks).toBeGreaterThan(20001);
    expect(position.targets.every((target) => target.priceTicks < 20001)).toBe(true);
    expect(positionSchema.safeParse(position).success).toBe(true);
  });

  it("should place a long when the click is at the last price or there is no last price", () => {
    expect(placed(20000, 20000).side).toBe("long");
    expect(placed(20000, null).side).toBe("long");
  });

  it("should snap the entry to the nearest tick when the click falls between ticks", () => {
    expect(placed(19950.4, 20000).entryTicks).toBe(19950);
    expect(placed(19950.6, 20000).entryTicks).toBe(19951);
  });

  it("should carry the contract, the time and one contract with one target when placed", () => {
    const position = placed(19950, 20000);

    expect(position.contractId).toBe("MESZ26");
    expect(position.createdMs).toBe(1760000000123);
    expect(position.quantity).toBe(1);
    expect(position.targets).toEqual([{ priceTicks: 19950 + 2 * defaultStopDistance(200), quantity: 1 }]);
    expect(position.state).toBe("planned");
  });
});

describe("defaultStopDistance", () => {
  it("should be a tenth of the visible span and never below one tick", () => {
    expect(defaultStopDistance(200)).toBe(20);
    expect(defaultStopDistance(3)).toBe(1);
    expect(defaultStopDistance(0)).toBe(1);
  });
});

describe("moveLine", () => {
  it("should move the stop to the dropped tick when the drop is valid", () => {
    expect(moved(moveLine(long, { kind: "stop" }, 19980)).stopTicks).toBe(19980);
  });

  it("should snap a dropped line to the nearest tick", () => {
    expect(moved(moveLine(long, { kind: "target", index: 1 }, 20030.6)).targets[1]?.priceTicks).toBe(20031);
    expect(moved(moveLine(long, { kind: "entry" }, 20004.2)).entryTicks).toBe(20004);
  });

  it("should refuse a long stop dropped at or above the entry, naming the rule", () => {
    const edit = moveLine(long, { kind: "stop" }, 20000);

    expect(edit).toEqual({ ok: false, reason: "the stop must be below the entry" });
  });

  it("should refuse a long entry dragged past a target, naming the rule", () => {
    const edit = moveLine(long, { kind: "entry" }, 20015);

    expect(edit).toEqual({ ok: false, reason: "a target must be above the entry" });
  });

  it("should refuse a market short's target dropped above its stop when it has no entry", () => {
    // With no entry, each target must still sit beyond the stop.
    expect(moveLine(marketShort, { kind: "target", index: 0 }, 20011)).toEqual({ ok: false, reason: "a target must be below the stop" });
    expect(moved(moveLine(marketShort, { kind: "target", index: 0 }, 20009)).targets[0]?.priceTicks).toBe(20009);
  });

  it("should refuse to move an entry a market position does not have", () => {
    expect(moveLine(marketShort, { kind: "entry" }, 20000)).toEqual({ ok: false, reason: "a market entry has no entry line" });
  });

  it("should refuse a target that does not exist", () => {
    expect(moveLine(long, { kind: "target", index: 2 }, 20040)).toEqual({ ok: false, reason: "there is no target 3" });
  });
});

describe("withSide", () => {
  it("should mirror the stop and targets about the entry when a long becomes a short", () => {
    const edit = withSide(long, "short");
    if (!edit.ok) throw new Error(edit.reason);

    expect(edit.position.side).toBe("short");
    expect(edit.position.stopTicks).toBe(20010);
    expect(edit.position.targets.map((target) => target.priceTicks)).toEqual([19990, 19980]);
  });

  it("should mirror the targets about the stop when a market position has no entry", () => {
    const edit = withSide(marketShort, "long");
    if (!edit.ok) throw new Error(edit.reason);

    expect(edit.position.stopTicks).toBe(20010);
    expect(edit.position.targets[0]?.priceTicks).toBe(20030);
  });
});

describe("withEntryType", () => {
  it("should drop the entry price when a limit becomes a market entry", () => {
    const edit = withEntryType(long, "market", 20000);
    if (!edit.ok) throw new Error(edit.reason);

    expect(edit.position.entryType).toBe("market");
    expect(edit.position.entryTicks).toBeNull();
  });

  it("should take the last price as the entry when a market becomes a limit and the last price fits", () => {
    const edit = withEntryType(marketShort, "limit", 20000);
    if (!edit.ok) throw new Error(edit.reason);

    expect(edit.position.entryTicks).toBe(20000);
  });

  it("should fall back to midway between the stop and the nearest target when the last price does not fit", () => {
    const edit = withEntryType(marketShort, "limit", 20500);
    if (!edit.ok) throw new Error(edit.reason);

    expect(edit.position.entryTicks).toBe(20000);
  });
});

describe("withQuantity and the targets", () => {
  it("should refuse a quantity outside 1 to 100 or below the targets' total", () => {
    expect(withQuantity(long, 0)).toEqual({ ok: false, reason: "the quantity must be a whole number from 1 to 100" });
    expect(withQuantity(long, 101)).toEqual({ ok: false, reason: "the quantity must be a whole number from 1 to 100" });
    expect(withQuantity(long, 2.5)).toEqual({ ok: false, reason: "the quantity must be a whole number from 1 to 100" });
    expect(withQuantity(long, 2)).toEqual({ ok: false, reason: "target quantities exceed the position quantity" });
    expect(withQuantity(long, 100).ok).toBe(true);
  });

  it("should refuse a target quantity that pushes the total past the position", () => {
    expect(withTargetQuantity(long, 0, 2)).toEqual({ ok: false, reason: "target quantities exceed the position quantity" });
    expect(withTargetQuantity(long, 0, 0)).toEqual({ ok: false, reason: "a target quantity must be a whole number from 1 to 100" });
  });

  it("should add a target beyond the furthest one with the contracts left, up to three", () => {
    const wider = withQuantity(long, 4);
    if (!wider.ok) throw new Error(wider.reason);
    const edit = addTarget(wider.position);
    if (!edit.ok) throw new Error(edit.reason);

    expect(edit.position.targets).toHaveLength(3);
    expect(edit.position.targets[2]).toEqual({ priceTicks: 20030, quantity: 1 });
    expect(addTarget(edit.position)).toEqual({ ok: false, reason: "a position has at most 3 targets" });
  });

  it("should refuse to add a target when every contract already has one", () => {
    expect(addTarget(long)).toEqual({ ok: false, reason: "every contract already has a target: raise the quantity first" });
  });

  it("should remove the named target", () => {
    const edit = removeTarget(long, 0);
    if (!edit.ok) throw new Error(edit.reason);

    expect(edit.position.targets).toEqual([{ priceTicks: 20020, quantity: 2 }]);
  });
});

describe("positionLines", () => {
  it("should list the entry, the stop and each target, each marked SIMULATED", () => {
    const lines = positionLines(long);

    expect(lines.map((line) => [line.line.kind, line.priceTicks])).toEqual([
      ["entry", 20000],
      ["stop", 19990],
      ["target", 20010],
      ["target", 20020],
    ]);
    expect(lines.map((line) => line.label)).toEqual(["SIMULATED long entry ×3", "SIMULATED stop", "SIMULATED target 1 ×1", "SIMULATED target 2 ×2"]);
  });

  it("should draw no entry line for a market entry with no price", () => {
    expect(positionLines(marketShort).map((line) => line.line.kind)).toEqual(["stop", "target"]);
  });
});

describe("a position that is being tracked", () => {
  const fill = (position: Position) => trackPrint(position, { sourceTimeMs: 5, priceTicks: 19999 });
  const filled = fill(long);
  const afterTarget = trackPrint(filled, { sourceTimeMs: 6, priceTicks: 20011 });
  const closed = trackPrint(filled, { sourceTimeMs: 7, priceTicks: 19980 });

  it("should refuse to change the side, type, quantity or entry once the entry has filled", () => {
    for (const edit of [
      withSide(filled, "short"),
      withEntryType(filled, "market", null),
      withQuantity(filled, 5),
      moveLine(filled, { kind: "entry" }, 19995),
    ]) {
      expect(edit).toEqual({ ok: false, reason: "the entry has filled: clear the position to start another" });
    }
  });

  it("should still let a working position change its entry", () => {
    expect(moveLine(trackPrint(long, { sourceTimeMs: 4, priceTicks: 20005 }), { kind: "entry" }, 19995).ok).toBe(true);
  });

  it("should let a filled position move its stop and an open target", () => {
    expect(moved(moveLine(filled, { kind: "stop" }, 19985)).stopTicks).toBe(19985);
    expect(moved(moveLine(afterTarget, { kind: "target", index: 1 }, 20030)).targets[1]?.priceTicks).toBe(20030);
  });

  it("should refuse to edit a target that has filled", () => {
    expect(moveLine(afterTarget, { kind: "target", index: 0 }, 20015)).toEqual({ ok: false, reason: "target 1 has filled" });
    expect(withTargetQuantity(afterTarget, 0, 2)).toEqual({ ok: false, reason: "target 1 has filled" });
    expect(removeTarget(afterTarget, 0)).toEqual({ ok: false, reason: "target 1 has filled" });
  });

  it("should refuse every stop and target edit once the position is closed", () => {
    const reason = "the position is closed: clear it to start another";
    expect(moveLine(closed, { kind: "stop" }, 19985)).toEqual({ ok: false, reason });
    expect(moveLine(closed, { kind: "target", index: 1 }, 20030)).toEqual({ ok: false, reason });
    expect(withTargetQuantity(closed, 1, 1)).toEqual({ ok: false, reason });
    expect(removeTarget(closed, 1)).toEqual({ ok: false, reason });
    expect(addTarget({ ...closed, quantity: 4 })).toEqual({ ok: false, reason });
  });

  it("should refuse to move a live target to or inside a filled one, which would reorder the scale-out", () => {
    const two = positionSchema.parse({ ...long, quantity: 2, targets: [{ priceTicks: 20010, quantity: 1 }, { priceTicks: 20020, quantity: 1 }] });
    const afterFirst = trackPrint(trackPrint(two, { sourceTimeMs: 5, priceTicks: 19999 }), { sourceTimeMs: 6, priceTicks: 20011 });
    const reason = "target 2 must stay beyond the target that has filled";
    expect(moveLine(afterFirst, { kind: "target", index: 1 }, 20005)).toEqual({ ok: false, reason });
    expect(moveLine(afterFirst, { kind: "target", index: 1 }, 20010)).toEqual({ ok: false, reason });
    expect(moved(moveLine(afterFirst, { kind: "target", index: 1 }, 20011)).targets[1]?.priceTicks).toBe(20011);
  });

  it("should apply the same reorder rule to a short", () => {
    const two = positionSchema.parse({ ...marketShort, entryType: "limit", entryTicks: 20000, quantity: 2, targets: [{ priceTicks: 19990, quantity: 1 }, { priceTicks: 19980, quantity: 1 }] });
    const afterFirst = trackPrint(trackPrint(two, { sourceTimeMs: 5, priceTicks: 20001 }), { sourceTimeMs: 6, priceTicks: 19989 });
    expect(moveLine(afterFirst, { kind: "target", index: 1 }, 19995).ok).toBe(false);
    expect(moveLine(afterFirst, { kind: "target", index: 1 }, 19989).ok).toBe(true);
  });

  it("should refuse a drag of the fill marker", () => {
    expect(moveLine(filled, { kind: "fill" }, 19990).ok).toBe(false);
  });

  it("should label a filled entry, a hit stop and a filled target, and draw a market fill", () => {
    expect(positionLines(afterTarget).map((line) => [line.label, line.done])).toEqual([
      ["SIMULATED long entry ×3 · filled", true],
      ["SIMULATED stop", false],
      ["SIMULATED target 1 ×1 · filled", true],
      ["SIMULATED target 2 ×2", false],
    ]);
    expect(positionLines(closed).find((line) => line.line.kind === "stop")).toMatchObject({ label: "SIMULATED stop · hit", done: true });
    const market = trackPrint(marketShort, { sourceTimeMs: 5, priceTicks: 20003 });
    expect(positionLines(market).find((line) => line.line.kind === "fill")).toMatchObject({ priceTicks: 20003, done: true });
  });

  it("should mark nothing done before the entry fills", () => {
    expect(positionLines(long).map((line) => line.done)).toEqual([false, false, false, false]);
  });

  it("should check a placed position like any edit", () => {
    expect(checkPosition(placed(19950, 20000)).ok).toBe(true);
    expect(checkPosition({ ...placed(19950, 20000), contractId: "" }).ok).toBe(false);
  });
});

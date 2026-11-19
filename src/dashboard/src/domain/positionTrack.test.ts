import { describe, expect, it } from "vitest";

import { positionSchema, type Position } from "./position.ts";
import {
  advanceTracker,
  feedGapStart,
  freshTracker,
  positionPnl,
  remainingQuantity,
  resumeTracker,
  trackPrint,
  trackPrints,
  trackingNote,
  type TrackFeed,
  type TrackerState,
} from "./positionTrack.ts";

// reference: REQUIREMENTS.md FR-72, FR-4, FR-11, UC-20; ARCHITECTURE.md D-59
// Synthetic prints only. Prices are whole ticks; one MES-like tick is worth 1.25.

const tickValue = 1.25;

function make(overrides: Record<string, unknown> = {}): Position {
  return positionSchema.parse({
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
    createdMs: 1_000,
    ...overrides,
  });
}

const short = (overrides: Record<string, unknown> = {}) =>
  make({
    side: "short",
    entryTicks: 20000,
    stopTicks: 20010,
    targets: [
      { priceTicks: 19990, quantity: 1 },
      { priceTicks: 19980, quantity: 2 },
    ],
    ...overrides,
  });

let clock = 10_000;
const at = (priceTicks: number, sourceTimeMs = (clock += 100)) => ({ sourceTimeMs, priceTicks });

describe("trackPrint: a limit entry", () => {
  it("fills a long only on a print strictly below its price, at the entry price", () => {
    const filled = trackPrint(make(), at(19999));
    expect(filled.state).toBe("filled");
    expect(filled.fill).toEqual({ timeMs: clock, priceTicks: 20000, riskTicks: 10 });
  });

  it("does not fill a long on a print exactly at its price", () => {
    const waiting = trackPrint(make(), at(20000));
    expect(waiting.state).toBe("working");
    expect(waiting.fill ?? null).toBeNull();
  });

  it("does not fill a long on a print above its price", () => {
    expect(trackPrint(make(), at(20005)).state).toBe("working");
  });

  it("fills a short only on a print strictly above its price, and not at it", () => {
    expect(trackPrint(short(), at(20000)).state).toBe("working");
    const filled = trackPrint(short(), at(20001));
    expect(filled.state).toBe("filled");
    expect(filled.fill?.priceTicks).toBe(20000);
  });

  it("moves a planned position to working on its first live print and keeps it there", () => {
    const first = trackPrint(make(), at(20005));
    expect(first.state).toBe("working");
    expect(trackPrint(first, at(20006))).toBe(first);
  });
});

describe("trackPrint: a market entry", () => {
  it("fills at the next print's price", () => {
    const filled = trackPrint(make({ entryType: "market", entryTicks: null }), at(20007));
    expect(filled.state).toBe("filled");
    expect(filled.fill?.priceTicks).toBe(20007);
  });

  it("does not take its own fill print as an exit", () => {
    const filled = trackPrint(make({ entryType: "market", entryTicks: null }), at(19985));
    expect(filled.state).toBe("filled");
    expect(filled.exits).toEqual([]);
  });
});

describe("trackPrint: exits", () => {
  const filledLong = () => trackPrint(make(), at(19999));

  it("fills the stop at the first print at it, at that print's price", () => {
    const closed = trackPrint(filledLong(), at(19990));
    expect(closed.state).toBe("closed");
    expect(closed.exits).toEqual([{ timeMs: clock, priceTicks: 19990, quantity: 3, kind: "stop" }]);
  });

  it("fills the stop at a print through it, at the print's price and not the stop's", () => {
    const closed = trackPrint(filledLong(), at(19985));
    expect(closed.exits[0]?.priceTicks).toBe(19985);
  });

  it("leaves the stop alone on a print one tick above it", () => {
    expect(trackPrint(filledLong(), at(19991)).state).toBe("filled");
  });

  it("does not fill a target on a print exactly at it", () => {
    const next = trackPrint(filledLong(), at(20010));
    expect(next.exits).toEqual([]);
  });

  it("fills a target on a print through it, at the target price, for the target's quantity", () => {
    const next = trackPrint(filledLong(), at(20011));
    expect(next.state).toBe("filled");
    expect(next.exits).toEqual([{ timeMs: clock, priceTicks: 20010, quantity: 1, kind: "target" }]);
    expect(remainingQuantity(next)).toBe(2);
  });

  it("scales out across targets in turn and closes when no quantity is left", () => {
    const first = trackPrint(filledLong(), at(20011));
    const last = trackPrint(first, at(20021));
    expect(last.exits.map((exit) => [exit.kind, exit.priceTicks, exit.quantity])).toEqual([
      ["target", 20010, 1],
      ["target", 20020, 2],
    ]);
    expect(last.state).toBe("closed");
    expect(remainingQuantity(last)).toBe(0);
  });

  it("fills several targets on one print that goes through them all", () => {
    const closed = trackPrint(filledLong(), at(20030));
    expect(closed.exits).toHaveLength(2);
    expect(closed.state).toBe("closed");
  });

  it("sends the contracts no target covers out with the last target", () => {
    const partial = trackPrint(make({ quantity: 4 }), at(19999));
    const closed = trackPrints(partial, [at(20011), at(20021)]);
    expect(closed.exits.map((exit) => exit.quantity)).toEqual([1, 3]);
    expect(closed.state).toBe("closed");
  });

  it("stops out only what is left after a target", () => {
    const afterTarget = trackPrint(filledLong(), at(20011));
    const stopped = trackPrint(afterTarget, at(19989));
    expect(stopped.exits.at(-1)).toMatchObject({ kind: "stop", quantity: 2, priceTicks: 19989 });
    expect(stopped.state).toBe("closed");
  });

  it("mirrors every rule for a short", () => {
    const filled = trackPrint(short(), at(20001));
    expect(trackPrint(filled, at(19990)).exits).toEqual([]);
    const target = trackPrint(filled, at(19989));
    expect(target.exits).toEqual([{ timeMs: clock, priceTicks: 19990, quantity: 1, kind: "target" }]);
    const stopped = trackPrint(filled, at(20010));
    expect(stopped.state).toBe("closed");
    expect(stopped.exits[0]).toMatchObject({ kind: "stop", priceTicks: 20010, quantity: 3 });
  });

  it("ignores a closed position", () => {
    const closed = trackPrint(filledLong(), at(19990));
    expect(trackPrint(closed, at(20100))).toBe(closed);
  });
});

describe("positionPnl", () => {
  it("is null before the entry fills", () => {
    expect(positionPnl(make(), tickValue, 20000)).toBeNull();
  });

  it("marks a long's open quantity to the last price in ticks, currency and R", () => {
    const pnl = positionPnl(trackPrint(make(), at(19999)), tickValue, 20006);
    // 3 contracts, 6 ticks each: 18 ticks, 22.50 currency, risk is 10 ticks x 3 contracts = 30, so 0.6 R.
    expect(pnl?.open).toMatchObject({ ticks: 18, currency: 22.5 });
    expect(pnl?.open?.r).toBeCloseTo(0.6, 10);
    expect(pnl?.realized).toMatchObject({ ticks: 0, currency: 0 });
    expect(pnl?.total.ticks).toBe(18);
  });

  it("splits a long's scale-out into legs and a total", () => {
    const afterTarget = trackPrint(trackPrint(make(), at(19999)), at(20011));
    const stopped = trackPrint(afterTarget, at(19990));
    const pnl = positionPnl(stopped, tickValue, 19990);
    // Target: +10 ticks x 1. Stop: -10 ticks x 2.
    expect(pnl?.legs.map((leg) => [leg.kind, leg.quantity, leg.legTicks, leg.ticks, leg.currency])).toEqual([
      ["target", 1, 10, 10, 12.5],
      ["stop", 2, -10, -20, -25],
    ]);
    expect(pnl?.realized).toMatchObject({ ticks: -10, currency: -12.5 });
    expect(pnl?.realized.r).toBeCloseTo(-10 / 30, 10);
    expect(pnl?.open).toBeNull();
    expect(pnl?.total.ticks).toBe(-10);
  });

  it("is the mirror image for a short", () => {
    const filled = trackPrint(short(), at(20001));
    const afterTarget = trackPrint(filled, at(19989));
    const pnl = positionPnl(afterTarget, tickValue, 19995);
    // Target leg +10 ticks; two contracts open, 5 ticks in profit each: +10 ticks.
    expect(pnl?.realized).toMatchObject({ ticks: 10, currency: 12.5 });
    expect(pnl?.open).toMatchObject({ ticks: 10, currency: 12.5 });
    expect(pnl?.total).toMatchObject({ ticks: 20, currency: 25 });
    expect(pnl?.total.r).toBeCloseTo(20 / 30, 10);
  });

  it("measures a market entry from the print it filled at", () => {
    const filled = trackPrint(make({ entryType: "market", entryTicks: null }), at(19996));
    const pnl = positionPnl(filled, tickValue, 20000);
    // Risk: 19996 - 19990 = 6 ticks; 4 ticks each in profit on 3 contracts.
    expect(pnl?.open?.ticks).toBe(12);
    expect(pnl?.open?.r).toBeCloseTo(12 / 18, 10);
  });

  it("has no open amount without a last price", () => {
    expect(positionPnl(trackPrint(make(), at(19999)), tickValue, null)?.open).toBeNull();
  });

  it("fixes R at the fill: moving the stop afterwards does not rescale it (D-59)", () => {
    const filled = trackPrint(make(), at(19999));
    expect(filled.fill?.riskTicks).toBe(10);
    const moved = positionPnl({ ...filled, stopTicks: 19999 }, tickValue, 20006);
    expect(moved?.open?.r).toBeCloseTo(0.6, 10);
    const atEntry = positionPnl({ ...filled, stopTicks: 20000 }, tickValue, 20006);
    expect(atEntry?.open?.r).toBeCloseTo(0.6, 10);
  });

  it("falls back to the stop as it stands for a fill saved without a risk basis, and has no R when that is zero", () => {
    const legacy = { ...trackPrint(make(), at(19999)), fill: { timeMs: 5, priceTicks: 20000 } };
    expect(positionPnl(legacy, tickValue, 20006)?.open?.r).toBeCloseTo(0.6, 10);
    expect(positionPnl({ ...legacy, stopTicks: 20000 }, tickValue, 20006)?.open?.r).toBeNull();
  });

  it("gives a market fill at or through the stop a one-tick basis, so R stays defined", () => {
    const filled = trackPrint(make({ entryType: "market", entryTicks: null }), at(19985));
    expect(filled.fill?.riskTicks).toBe(5);
    const onStop = trackPrint(make({ entryType: "market", entryTicks: null }), at(19990));
    expect(onStop.fill?.riskTicks).toBe(1);
  });
});

describe("feedGapStart", () => {
  const status = (over: Record<string, unknown> = {}) => ({
    code: "LIVE",
    connected: true,
    bookKnown: true,
    depthSubscribed: true,
    missingSinceMs: null,
    ...over,
  });

  it("is null for a healthy feed of any provenance", () => {
    for (const code of ["LIVE", "SIMULATED", "REPLAY"]) expect(feedGapStart(status({ code }), 50_000)).toBeNull();
  });

  it("starts at the time data went missing when DEGRADED", () => {
    expect(feedGapStart(status({ code: "DEGRADED", missingSinceMs: 40_000 }), 50_000)).toBe(40_000);
  });

  it("starts now for a status that is neither healthy nor dated", () => {
    expect(feedGapStart(status({ code: "STALE" }), 50_000)).toBe(50_000);
    expect(feedGapStart(status({ connected: false }), 50_000)).toBe(50_000);
  });

  it("treats an open dropped-trade gap as a gap even when the code reads LIVE", () => {
    expect(feedGapStart(status({ missingSinceMs: 45_000 }), 50_000)).toBe(45_000);
  });

  it("treats an unknown book as a gap only when depth is subscribed (FR-11)", () => {
    expect(feedGapStart(status({ bookKnown: false }), 50_000)).toBe(50_000);
    expect(feedGapStart(status({ bookKnown: false, depthSubscribed: false }), 50_000)).toBeNull();
  });
});

describe("advanceTracker", () => {
  const print = (sequence: number, priceTicks: number, sourceTimeMs = 20_000 + sequence * 100) => ({
    sequence,
    sourceTimeMs,
    priceTicks,
    quantity: 1,
    aggressor: "Buy",
  });
  const feed = (prints: ReturnType<typeof print>[], over: Partial<TrackFeed> = {}): TrackFeed => ({
    prints,
    epoch: 1,
    serverTimeMs: 30_000,
    watermarkMs: null,
    gapStartMs: null,
    ...over,
  });
  const started = (prints: ReturnType<typeof print>[] = [print(1, 20005)]): TrackerState =>
    advanceTracker(freshTracker(null), make(), feed(prints)).tracker;

  it("counts none of the prints already on the first feed it sees", () => {
    const step = advanceTracker(freshTracker(null), make(), feed([print(1, 19990)]));
    expect(step.position?.state).toBe("planned");
    expect(step.counted).toEqual([]);
  });

  it("counts a print that arrives after, once", () => {
    const tracker = started();
    const first = advanceTracker(tracker, make(), feed([print(1, 20005), print(2, 19999)]));
    expect(first.position?.state).toBe("filled");
    expect(first.counted.map((item) => item.sequence)).toEqual([2]);
    const again = advanceTracker(first.tracker, first.position, feed([print(1, 20005), print(2, 19999)]));
    expect(again.counted).toEqual([]);
    expect(again.position).toBe(first.position);
  });

  it("skips warmup prints at or before the history watermark", () => {
    const step = advanceTracker(started(), make(), feed([print(2, 19999, 25_000)], { watermarkMs: 25_000 }));
    expect(step.position?.state).toBe("planned");
    const live = advanceTracker(
      step.tracker,
      make(),
      feed([print(2, 19999, 25_000), print(3, 19999, 25_001)], { watermarkMs: 25_000 }),
    );
    expect(live.position?.state).toBe("filled");
  });

  it("fills nothing inside a gap and says when it began", () => {
    const gap = advanceTracker(started(), make(), feed([print(2, 19999)], { gapStartMs: 26_000 }));
    expect(gap.position?.state).toBe("planned");
    expect(gap.tracker.gapSinceMs).toBe(26_000);
    expect(trackingNote(gap.tracker, gap.position, (ms) => `t${ms}`)).toBe("not tracked since t26000 CT");
  });

  it("keeps the first start of a gap while it lasts", () => {
    const first = advanceTracker(started(), make(), feed([print(2, 20005)], { gapStartMs: 26_000 }));
    const later = advanceTracker(first.tracker, first.position, feed([print(3, 20005)], { gapStartMs: 29_000 }));
    expect(later.tracker.gapSinceMs).toBe(26_000);
  });

  it("resumes after the gap, with the gap's prints still uncounted", () => {
    const gap = advanceTracker(started(), make(), feed([print(2, 19999)], { gapStartMs: 26_000 }));
    const healed = advanceTracker(gap.tracker, gap.position, feed([print(2, 19999), print(3, 20005)], { serverTimeMs: 31_000 }));
    expect(healed.position?.state).toBe("working");
    expect(healed.tracker.gapSinceMs).toBeNull();
    expect(healed.tracker.lastGap).toEqual({ fromMs: 26_000, toMs: 31_000 });
    expect(trackingNote(healed.tracker, healed.position, (ms) => `t${ms}`)).toBe("not tracked t26000–t31000 CT");
  });

  it("treats a new epoch as a gap whose prints are not counted", () => {
    const step = advanceTracker(started(), make(), feed([print(5, 19990)], { epoch: 2, serverTimeMs: 33_000 }));
    expect(step.position?.state).toBe("planned");
    expect(step.tracker.lastGap).toEqual({ fromMs: 30_000, toMs: 33_000 });
    const next = advanceTracker(
      step.tracker,
      step.position,
      feed([print(5, 19990), print(6, 19999)], { epoch: 2, serverTimeMs: 33_100 }),
    );
    expect(next.position?.state).toBe("filled");
  });

  it("on a resume skips exactly the prints at or before the heartbeat's sequence in the same epoch, by sequence and not by time", () => {
    const resumed = resumeTracker({ wallMs: 100_000, feedMs: 90_000, sequence: 2, epoch: 1 }, null, 101_000);
    const filled = trackPrint(make({ stopTicks: 19990 }), { sourceTimeMs: 20_200, priceTicks: 19985 });
    // Prints 2 and 3 share the fill's millisecond: 2 is the fill, already in the position, and 3 is new.
    const step = advanceTracker(resumed, filled, feed([print(1, 20005), print(2, 19985, 20_200), print(3, 19985, 20_200)]));
    expect(step.counted.map((item) => item.sequence)).toEqual([3]);
    expect(step.position?.state).toBe("closed");
    expect(step.position?.exits).toHaveLength(1);
  });

  it("counts a stop print that shares the fill's millisecond when it arrives in a later feed", () => {
    const first = advanceTracker(started(), make({ stopTicks: 19990 }), feed([print(1, 20005), print(2, 19999, 20_500)]));
    expect(first.position?.state).toBe("filled");
    const second = advanceTracker(first.tracker, first.position, feed([print(1, 20005), print(2, 19999, 20_500), print(3, 19985, 20_500)]));
    expect(second.counted.map((item) => item.sequence)).toEqual([3]);
    expect(second.position).toMatchObject({ state: "closed", exits: [{ kind: "stop", priceTicks: 19985 }] });
  });

  it("counts a second target's print that shares the first target's millisecond in a later feed", () => {
    const two = make({ quantity: 2, targets: [{ priceTicks: 20010, quantity: 1 }, { priceTicks: 20020, quantity: 1 }] });
    const filled = trackPrint(two, { sourceTimeMs: 20_100, priceTicks: 19999 });
    const first = advanceTracker({ ...freshTracker(null), lastSequence: 1, epoch: 1, lastServerTimeMs: 30_000 }, filled, feed([print(1, 20005), print(2, 20011, 20_600)]));
    expect(first.position?.exits).toHaveLength(1);
    const second = advanceTracker(first.tracker, first.position, feed([print(2, 20011, 20_600), print(3, 20021, 20_600)]));
    expect(second.position).toMatchObject({ state: "closed" });
    expect(second.position?.exits).toHaveLength(2);
  });

  it("does not show a gap that ended before the position was placed", () => {
    const gap = advanceTracker(started(), make(), feed([], { gapStartMs: 26_000 }));
    const healed = advanceTracker(gap.tracker, gap.position, feed([], { serverTimeMs: 31_000 }));
    expect(trackingNote(healed.tracker, make({ createdMs: 31_001 }), String)).toBeNull();
    expect(trackingNote(healed.tracker, make({ createdMs: 31_000 }), String)).not.toBeNull();
  });

  it("says nothing for a position that is closed or absent", () => {
    const gap = advanceTracker(started(), make(), feed([], { gapStartMs: 26_000 }));
    const closed = {
      ...make(),
      state: "closed" as const,
      fill: { timeMs: 2, priceTicks: 20000 },
      exits: [{ timeMs: 3, priceTicks: 19990, quantity: 3, kind: "stop" as const }],
    };
    expect(trackingNote(gap.tracker, closed, String)).toBeNull();
    expect(trackingNote(gap.tracker, null, String)).toBeNull();
  });
});

describe("resumeTracker", () => {
  const beat = { wallMs: 100_000, feedMs: 90_000, sequence: 7, epoch: 3 };

  it("carries on from a recent heartbeat, so a tab switch loses no print", () => {
    const tracker = resumeTracker(beat, null, 105_000);
    expect(tracker).toMatchObject({ lastSequence: 7, epoch: 3, gapSinceMs: null });
  });

  it("opens a gap at the feed time of a stale heartbeat: the tab was closed", () => {
    const tracker = resumeTracker(beat, null, 400_000);
    expect(tracker.gapSinceMs).toBe(90_000);
    expect(tracker.epoch).toBeNull();
  });

  it("opens a gap at a stored position's last event when there is no heartbeat", () => {
    const tracker = resumeTracker(null, make({ createdMs: 50_000 }), 400_000);
    expect(tracker.gapSinceMs).toBe(50_000);
  });

  it("opens no gap for a position placed moments ago, or for none", () => {
    expect(resumeTracker(null, make({ createdMs: 399_000 }), 400_000).gapSinceMs).toBeNull();
    expect(resumeTracker(null, null, 400_000).gapSinceMs).toBeNull();
  });

  it("measures a filled position from its last exit", () => {
    const filled = { ...make({ createdMs: 50_000 }), state: "filled" as const, fill: { timeMs: 60_000, priceTicks: 20000 }, exits: [] };
    expect(resumeTracker(null, filled, 400_000).gapSinceMs).toBe(60_000);
  });
});

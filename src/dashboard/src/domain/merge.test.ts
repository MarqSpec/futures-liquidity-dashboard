import { describe, expect, it } from "vitest";

import { deltaFixture, emptyDelta, snapshotFixture } from "../test/fixtures.ts";
import { MAX_SIGNALS, appendNew, applyDelta, fromSnapshot, indicatorsForViewer, upsertByTime } from "./merge.ts";

const snapshot = snapshotFixture();
const start = () => fromSnapshot(snapshot, 5, 1000);
const next = (overrides = {}) => deltaFixture({ seq: snapshot.seq + 1, ...overrides });

describe("appendNew", () => {
  it("should append only items newer than the last one when the incoming items overlap", () => {
    const merged = appendNew([{ t: 1 }, { t: 2 }], [{ t: 2 }, { t: 3 }], (x) => x.t);

    expect(merged.map((x) => x.t)).toEqual([1, 2, 3]);
  });

  it("should return the same array when nothing is new", () => {
    const existing = [{ t: 1 }];

    expect(appendNew(existing, [{ t: 1 }], (x) => x.t)).toBe(existing);
  });
});

describe("upsertByTime", () => {
  it("should replace an older minute when a repair arrives behind the live bar", () => {
    const existing = [
      { t: 60_000, v: 0 },
      { t: 120_000, v: 4 },
    ];

    const merged = upsertByTime(existing, [{ t: 60_000, v: 40 }]);

    expect(merged).toEqual([
      { t: 60_000, v: 40 },
      { t: 120_000, v: 4 },
    ]);
  });
});

describe("fromSnapshot", () => {
  it("should take the seq of the snapshot when it builds the state", () => {
    expect(start().seq).toBe(snapshot.seq);
  });

  it("should drop heat slices older than the history window when they are outside it", () => {
    const old = { t: snapshot.serverTimeMs - 6 * 60_000, d: 1000, c: [1, 1, 1, 1000] };
    const state = fromSnapshot({ ...snapshot, heat: [old, ...snapshot.heat] }, 5, 0);

    expect(state.heat).toHaveLength(snapshot.heat.length);
  });
});

describe("applyDelta", () => {
  it("should append only prints newer than the last sequence when the delta overlaps the snapshot", () => {
    const held = fromSnapshot(
      {
        ...snapshot,
        prints: [
          { sourceTimeMs: 1, priceTicks: 10, quantity: 1, aggressor: "Bid", sequence: 1 },
          { sourceTimeMs: 2, priceTicks: 11, quantity: 2, aggressor: "Ask", sequence: 2 },
        ],
      },
      5,
      0,
    );
    const delta = next({
      prints: [
        { sourceTimeMs: 2, priceTicks: 11, quantity: 2, aggressor: "Ask", sequence: 2 },
        { sourceTimeMs: 3, priceTicks: 12, quantity: 4, aggressor: "Bid", sequence: 3 },
      ],
    });

    const nextState = applyDelta(held, delta, 3);
    expect(nextState.prints.map((print) => print.sequence)).toEqual([1, 2, 3]);
    expect(held.printArrivedAtMs).toBe(0);
    expect(nextState.printArrivedAtMs).toBe(3);

    const repeated = applyDelta(nextState, next({ prints: [] }), 9);
    expect(repeated.printArrivedAtMs).toBe(3);
  });

  it("should drop prints from the previous epoch when the delta's epoch changes", () => {
    const held = fromSnapshot(
      {
        ...snapshot,
        prints: [{ sourceTimeMs: 1, priceTicks: 10, quantity: 1, aggressor: "Bid", sequence: 1 }],
      },
      5,
      0,
    );
    const delta = next({
      status: { ...snapshot.status, epoch: snapshot.status.epoch + 1 },
      prints: [{ sourceTimeMs: 9, priceTicks: 12, quantity: 4, aggressor: "Ask", sequence: 2 }],
    });

    const nextState = applyDelta(held, delta, 3);
    expect(nextState.prints.map((print) => print.sequence)).toEqual([2]);
    expect(nextState.printArrivedAtMs).toBe(3);
  });

  it("should append a newly closed footprint when the delta carries one", () => {
    const state = applyDelta(start(), next(), 2000);

    expect(state.orderFlow.footprints.map((f) => f.t)).toEqual([1794114840000, 1794114900000, 1794114960000]);
  });

  it("should replace a footprint the client already holds when the repair fills that minute", () => {
    const held = start().orderFlow.footprints[0];
    expect(held).toBeDefined();
    const repaired = held ? { ...held, v: held.v + 25, approximate: true } : held;
    const delta = next({ orderFlow: { ...next().orderFlow, footprints: repaired ? [repaired] : [] } });

    const footprints = applyDelta(start(), delta, 2000).orderFlow.footprints;

    expect(footprints.find((bar) => bar.t === held?.t)?.v).toBe((held?.v ?? 0) + 25);
    expect(footprints).toHaveLength(start().orderFlow.footprints.length);
  });

  it("should not duplicate a footprint when the delta repeats one the snapshot held", () => {
    const repeated = snapshot.orderFlow.footprints.at(-1);
    const delta = next({ orderFlow: { ...next().orderFlow, footprints: repeated ? [repeated] : [] } });

    expect(applyDelta(start(), delta, 2000).orderFlow.footprints).toHaveLength(snapshot.orderFlow.footprints.length);
  });

  it("should append new CVD points by time when the delta closes a bar", () => {
    const state = applyDelta(start(), next(), 2000);

    expect(state.orderFlow.cvdPoints.at(-1)).toEqual([1794115020000, 10670]);
  });

  it("should keep signals inside the history window when there are more than the old caps", () => {
    const template = snapshot.orderFlow.signals[0];
    if (!template) throw new Error("the snapshot fixture has no signal");
    const fromMs = snapshot.serverTimeMs - 5 * 60_000;
    const inside = Array.from({ length: 1_001 }, (_, index) => ({
      ...template,
      id: index + 1,
      timeMs: snapshot.serverTimeMs - 60_000 + index,
    }));
    const stale = { ...template, id: 0, timeMs: fromMs - 1 };
    const state = fromSnapshot({ ...snapshot, orderFlow: { ...snapshot.orderFlow, signals: [stale, ...inside] } }, 5, 0);

    expect(state.orderFlow.signals).toHaveLength(1_001);
    expect(state.orderFlow.signals[0]?.id).toBe(1);
    expect(state.orderFlow.signals.some((signal) => signal.timeMs < fromMs)).toBe(false);
    expect(1_001).toBeGreaterThan(40);
    expect(1_001).toBeLessThan(MAX_SIGNALS);

    const extra = { ...template, id: 5_000, timeMs: snapshot.serverTimeMs };
    const appended = applyDelta(state, next({ orderFlow: { ...next().orderFlow, signals: [extra] } }), 2_000);

    expect(appended.orderFlow.signals).toHaveLength(1_002);
    expect(appended.orderFlow.signals.at(-1)?.id).toBe(5_000);
  });

  it("should restore signals older than one hundred of one kind when a reloaded snapshot still has them inside the history", () => {
    const template = snapshot.orderFlow.signals[0];
    if (!template) throw new Error("the snapshot fixture has no signal");
    const fromMs = snapshot.serverTimeMs - 5 * 60_000;
    const signals = Array.from({ length: 150 }, (_, index) => ({
      ...template,
      id: index + 1,
      kind: "StackedImbalance" as const,
      timeMs: fromMs + 1_000 + index * 1_000,
    }));

    const reloaded = fromSnapshot({ ...snapshot, orderFlow: { ...snapshot.orderFlow, signals } }, 5, 0);

    expect(reloaded.orderFlow.signals).toHaveLength(150);
    expect(reloaded.orderFlow.signals[0]?.id).toBe(1);
    expect(reloaded.orderFlow.signals[0]?.timeMs).toBeGreaterThanOrEqual(fromMs);
    expect(reloaded.orderFlow.signals.at(-1)?.id).toBe(150);
    expect(150).toBeGreaterThan(100);
  });

  it("should append new signals by id without duplicates when the delta repeats one", () => {
    const repeated = snapshot.orderFlow.signals.at(-1);
    const fresh = next().orderFlow.signals;
    const delta = next({ orderFlow: { ...next().orderFlow, signals: repeated ? [repeated, ...fresh] : fresh } });

    const held = start().orderFlow.signals;
    const ids = applyDelta(start(), delta, 2000).orderFlow.signals.map((s) => s.id);

    expect(held.length).toBeGreaterThan(0);
    expect(held.length).toBeLessThan(snapshot.orderFlow.signals.length);
    expect(ids).toEqual([...held.map((s) => s.id), 428, 429]);
  });

  it("should append new indicator points and replace the developing value when the delta has them", () => {
    const ema10 = applyDelta(start(), next(), 2000).indicators.find((i) => i.id === "ema10");

    expect(ema10?.points.at(-1)).toEqual([1794115020000, 27565.5538]);
  });

  it("should keep indicator points when the delta carries none", () => {
    const ema10 = applyDelta(start(), emptyDelta(snapshot.seq + 1), 2000).indicators.find((i) => i.id === "ema10");

    expect(ema10?.points).toHaveLength(3);
  });

  it("should keep both timeframes when the same indicator id arrives at two source timeframes", () => {
    const ema10 = snapshot.indicators.find((series) => series.id === "ema10");
    expect(ema10).toBeDefined();
    const slower = { ...ema10!, tf: 300, points: [[1794114900000, 100]] };
    const state = fromSnapshot({ ...snapshot, indicators: [...snapshot.indicators, slower] }, 5, 1000);
    const point = [1794115080000, 101];
    const delta = next({ indicators: [{ ...slower, points: [point] }] });

    const merged = applyDelta(state, delta, 2000).indicators.filter((series) => series.id === "ema10");

    expect(merged.map((series) => series.tf).sort((a, b) => a - b)).toEqual([ema10!.tf, 300]);
    expect(merged.find((series) => series.tf === 300)?.points.at(-1)).toEqual(point);
    expect(merged.find((series) => series.tf === ema10!.tf)?.points).toHaveLength(ema10!.points.length);
  });

  it("should replace the ladder when the delta carries a new one", () => {
    const ladder = { bids: [[100, 1] as [number, number]], asks: [[101, 2] as [number, number]] };

    expect(applyDelta(start(), next({ ladder }), 2000).ladder).toEqual(ladder);
  });

  it("should replace the icebergs as current state when the delta carries them", () => {
    const delta = next();

    expect(applyDelta(start(), delta, 2000).orderFlow.icebergs).toEqual(delta.orderFlow.icebergs);
  });

  it("should trim heat slices that fall out of the window when time moves on", () => {
    const later = next({ serverTimeMs: snapshot.serverTimeMs + 10 * 60_000 });

    expect(applyDelta(start(), later, 2000).heat.every((h) => h.t >= later.serverTimeMs - 5 * 60_000)).toBe(true);
  });

  it("should take the delta's seq when it is applied", () => {
    expect(applyDelta(start(), next(), 2000).seq).toBe(snapshot.seq + 1);
  });

  it("should sample the VWAP into its trail when time has moved on a second", () => {
    const later = next({ serverTimeMs: snapshot.serverTimeMs + 1500 });

    expect(applyDelta(start(), later, 2000).vwapTrail).toHaveLength(2);
  });
});

describe("indicatorsForViewer", () => {
  it("should return only the chosen timeframe when the publication carries several", () => {
    const ema10 = snapshot.indicators.find((series) => series.id === "ema10");
    const indicators = [ema10!, { ...ema10!, tf: 300, points: [[1, 2]] }, { ...ema10!, tf: 900, points: [[3, 4]] }];

    expect(indicatorsForViewer(indicators, 5).map((series) => series.tf)).toEqual([300]);
  });

  it("should draw nothing when the chosen timeframe is absent", () => {
    const chosen = indicatorsForViewer(snapshot.indicators, 15);

    expect(chosen).toEqual([]);
    expect(chosen.some((series) => series.tf === 60)).toBe(false);
  });
});

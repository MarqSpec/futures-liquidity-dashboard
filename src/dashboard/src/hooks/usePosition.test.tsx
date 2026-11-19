// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultLayout, type LayoutSettings } from "../domain/layout.ts";
import { fromSnapshot, type MarketState } from "../domain/merge.ts";
import { positionSchema, type Position } from "../domain/position.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { usePosition } from "./usePosition.ts";

// reference: REQUIREMENTS.md FR-72, FR-4, FR-11, UC-20; ARCHITECTURE.md D-58, D-59
// Synthetic prints on the synthetic snapshot fixture (root ES, tick value 12.5).

const base = fromSnapshot(snapshotFixture(), 5, 0);
const nowMs = base.serverTimeMs + 5_000;
const beatKey = `futures-liquidity-dashboard.position-beat.${base.root}`;

function print(sequence: number, priceTicks: number, sourceTimeMs = base.serverTimeMs + sequence * 100) {
  return { sequence, priceTicks, sourceTimeMs, quantity: 1, aggressor: "Buy" };
}

function marketWith(prints: ReturnType<typeof print>[], over: Partial<MarketState> = {}): MarketState {
  const last = prints.at(-1);
  return { ...base, prints, serverTimeMs: last ? last.sourceTimeMs : base.serverTimeMs, ...over };
}

const limitLong: Position = positionSchema.parse({
  side: "long",
  entryType: "limit",
  entryTicks: 20000,
  quantity: 2,
  stopTicks: 19990,
  targets: [{ priceTicks: 20010, quantity: 2 }],
  contractId: base.instrument.contractId,
  createdMs: nowMs - 1_000,
});

function harness(initial: Position | null, first: MarketState) {
  const updates = vi.fn();
  const view = renderHook(
    ({ market }: { market: MarketState }) => {
      const [layout, setLayout] = useState<LayoutSettings>({ ...defaultLayout, positions: initial ? { [market.root]: initial } : {} });
      const onReading = (change: (current: LayoutSettings) => LayoutSettings) => {
        updates();
        setLayout((current) => change(current));
      };
      return { layout, editor: usePosition({ root: market.root, contractId: market.instrument.contractId, positions: layout.positions, onReading, market }) };
    },
    { initialProps: { market: first } },
  );
  return { ...view, updates, position: () => view.result.current.editor.position };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(nowMs);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
});

describe("usePosition: placing", () => {
  it("should save a placed position that passes FR-72", () => {
    const view = harness(null, marketWith([print(1, 20005)]));
    act(() => view.result.current.editor.place(19950, 20000, 200));
    expect(view.position()?.entryTicks).toBe(19950);
    expect(view.result.current.editor.notice).toBeNull();
    expect(view.updates).toHaveBeenCalledTimes(1);
  });

  it("should refuse a placed position that breaks FR-72, with the rule, and save nothing", () => {
    const view = harness(null, marketWith([print(1, 20005)]));
    act(() => view.result.current.editor.place(Number.NaN, 20000, 200));
    expect(view.position()).toBeNull();
    expect(view.result.current.editor.notice).toMatch(/^Sprang back: /);
    expect(view.updates).not.toHaveBeenCalled();
  });

  it("should refuse a placement for a contract it cannot name", () => {
    const updates = vi.fn();
    const { result } = renderHook(() =>
      usePosition({ root: base.root, contractId: "", positions: {}, onReading: updates, market: marketWith([print(1, 20005)]) }),
    );
    act(() => result.current.place(19950, 20000, 200));
    expect(result.current.notice).toMatch(/^Sprang back: /);
    expect(updates).not.toHaveBeenCalled();
  });
});

describe("usePosition: tracking", () => {
  it("should fill a limit on a later print through it and save the fill", () => {
    const view = harness(limitLong, marketWith([print(1, 20005)]));
    view.rerender({ market: marketWith([print(1, 20005), print(2, 19999)]) });
    expect(view.position()).toMatchObject({ state: "filled", fill: { priceTicks: 20000 } });
    expect(view.updates).toHaveBeenCalled();
  });

  it("should not count the prints already in the first feed, nor save for them", () => {
    const view = harness(limitLong, marketWith([print(1, 19990)]));
    expect(view.position()?.state).toBe("planned");
    expect(view.updates).not.toHaveBeenCalled();
  });

  it("should close the position on its target and report P&L in ticks, currency and R", () => {
    const view = harness(limitLong, marketWith([print(1, 20005)]));
    view.rerender({ market: marketWith([print(1, 20005), print(2, 19999)]) });
    view.rerender({ market: marketWith([print(1, 20005), print(2, 19999), print(3, 20011)]) });
    expect(view.position()?.state).toBe("closed");
    const total = view.result.current.editor.tracking.pnl?.total;
    expect(total?.ticks).toBe(20);
    expect(total?.currency).toBe(250);
    expect(total?.r).toBeCloseTo(1, 10);
  });

  it("should not fill inside a DEGRADED gap, and say when the gap began", () => {
    const view = harness(limitLong, marketWith([print(1, 20005)]));
    const degraded = { ...base.status, code: "DEGRADED", missingSinceMs: base.serverTimeMs + 50 };
    view.rerender({ market: marketWith([print(1, 20005), print(2, 19999)], { status: degraded }) });
    expect(view.position()?.state).toBe("planned");
    expect(view.result.current.editor.tracking.note).toMatch(/^not tracked since \d\d:\d\d CT$/);
  });

  it("should not fill while the feed is not live at all, as when it is STALE", () => {
    const view = harness(limitLong, marketWith([print(1, 20005)]));
    view.rerender({ market: marketWith([print(1, 20005), print(2, 19999)], { status: { ...base.status, code: "STALE" } }) });
    expect(view.position()?.state).toBe("planned");
  });

  it("should not fill on a warmup print at or before the history watermark", () => {
    const watermark = base.serverTimeMs + 300;
    const view = harness(limitLong, marketWith([print(1, 20005)], { historyWatermarkMs: watermark }));
    view.rerender({ market: marketWith([print(1, 20005), print(3, 19999, watermark)], { historyWatermarkMs: watermark }) });
    expect(view.position()?.state).toBe("planned");
  });

  it("should count a print the second a tab switch spans, from a recent heartbeat", () => {
    localStorage.setItem(beatKey, JSON.stringify({ wallMs: nowMs - 500, feedMs: base.serverTimeMs, sequence: 1, epoch: base.status.epoch }));
    const view = harness(limitLong, marketWith([print(1, 20005), print(2, 19999)]));
    expect(view.position()?.state).toBe("filled");
    expect(view.result.current.editor.tracking.note).toBeNull();
  });

  it("should show the time the tab was closed as not tracked, and fill nothing from it", () => {
    localStorage.setItem(beatKey, JSON.stringify({ wallMs: nowMs - 600_000, feedMs: base.serverTimeMs - 600_000, sequence: 1, epoch: base.status.epoch }));
    const placedBefore = { ...limitLong, createdMs: base.serverTimeMs - 700_000 };
    const view = harness(placedBefore, marketWith([print(1, 20005), print(2, 19999)]));
    expect(view.position()?.state).toBe("planned");
    expect(view.result.current.editor.tracking.note).toMatch(/^not tracked \d\d:\d\d.\d\d:\d\d CT$/);
  });

  it("should keep a heartbeat while a position is live and drop it when the position is gone", () => {
    const view = harness(limitLong, marketWith([print(1, 20005)]));
    expect(JSON.parse(localStorage.getItem(beatKey) ?? "null")).toMatchObject({ sequence: 1, epoch: base.status.epoch });
    act(() => view.result.current.editor.clear());
    expect(localStorage.getItem(beatKey)).toBeNull();
  });
});

// (review round 1, finding 2)
describe("usePosition: leaving and coming back within a second", () => {
  const beatSequence = () => JSON.parse(localStorage.getItem(beatKey) ?? "null")?.sequence;

  it("should write the heartbeat as soon as a print is counted, whatever the throttle", () => {
    const view = harness(limitLong, marketWith([print(1, 20005)]));
    view.rerender({ market: marketWith([print(1, 20005), print(2, 19985)]) });
    expect(view.position()?.state).toBe("filled");
    expect(beatSequence()).toBe(2);
  });

  it("should write the newest heartbeat when the view unmounts, even for prints the throttle held back", () => {
    const view = harness(limitLong, marketWith([print(1, 20005)]));
    const degraded = { ...base.status, code: "DEGRADED", missingSinceMs: base.serverTimeMs + 50 };
    view.rerender({ market: marketWith([print(1, 20005), print(2, 20005)], { status: degraded }) });
    expect(beatSequence()).toBe(1);
    view.unmount();
    expect(beatSequence()).toBe(2);
  });

  it("should count nothing twice when the view is remounted within a second of a counted print", () => {
    const first = harness(limitLong, marketWith([print(1, 20005)]));
    // Print 2 fills the entry at 20000; the print that fills is not also an exit, so the stop at 19990 is not taken.
    first.rerender({ market: marketWith([print(1, 20005), print(2, 19985)]) });
    const saved = first.position();
    expect(saved).toMatchObject({ state: "filled", exits: [] });
    first.unmount();

    const second = harness(saved, marketWith([print(1, 20005), print(2, 19985)]));
    expect(second.position()).toMatchObject({ state: "filled", exits: [] });
    expect(second.updates).not.toHaveBeenCalled();
  });

  it("should still take a print that arrives after the remount", () => {
    const first = harness(limitLong, marketWith([print(1, 20005)]));
    first.rerender({ market: marketWith([print(1, 20005), print(2, 19985)]) });
    const saved = first.position();
    first.unmount();

    const second = harness(saved, marketWith([print(1, 20005), print(2, 19985)]));
    second.rerender({ market: marketWith([print(1, 20005), print(2, 19985), print(3, 19985)]) });
    expect(second.position()).toMatchObject({ state: "closed", exits: [{ kind: "stop", priceTicks: 19985 }] });
  });
});

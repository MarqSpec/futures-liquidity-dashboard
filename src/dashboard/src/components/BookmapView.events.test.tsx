// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Signal, Snapshot } from "../api/schemas.ts";
import { bookmapFrame, bookmapScales, pointerOnPriceLine } from "../domain/bookmap.ts";
import { formatTicks } from "../domain/format.ts";
import { defaultLayout } from "../domain/layout.ts";
import { fromSnapshot } from "../domain/merge.ts";
import { fitRange } from "../domain/scale.ts";
import { LIVE_EDGE_PAD, defaultWindow } from "../domain/viewWindow.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { BookmapView } from "./BookmapView.tsx";

const arcs: number[] = [];

beforeAll(() => {
  globalThis.ResizeObserver = class {
    private readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      this.callback(
        [
          {
            target,
            contentRect: { width: 800, height: 400, x: 0, y: 0, top: 0, left: 0, bottom: 400, right: 800, toJSON() { return {}; } },
          } as ResizeObserverEntry,
        ],
        this,
      );
    }
    unobserve() {}
    disconnect() {}
  };
  HTMLCanvasElement.prototype.getContext = (() => {
    const state: Record<string | symbol, unknown> = { fillStyle: "#000", strokeStyle: "#000" };
    return new Proxy(state, {
      get(target, key) {
        if (key in target) return target[key];
        if (key === "measureText") return () => ({ width: 12 });
        if (key === "createPattern") return () => null;
        return (...args: unknown[]) => {
          if (key === "arc" && typeof args[2] === "number") arcs.push(args[2]);
        };
      },
      set(target, key, value) {
        target[key] = value;
        return true;
      },
    });
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  arcs.length = 0;
  cleanup();
});

const base = fromSnapshot(snapshotFixture(), 5, 0);
const template = snapshotFixture().orderFlow.signals[0];

function event(id: number, timeMs: number, priceTicks: number): Signal {
  if (!template) throw new Error("the snapshot fixture has no signal");
  return { ...template, id, kind: "StackedImbalance", timeMs, priceTicks, priceHighTicks: priceTicks, label: "Stacked imbalance" };
}

describe("BookmapView event dots", () => {
  it("should draw every in-window event when there are more than 40", () => {
    const signals = Array.from({ length: 41 }, (_, index) => event(index + 1, base.serverTimeMs - 60_000 + index * 500, 100));
    const market = { ...base, prints: [], orderFlow: { ...base.orderFlow, signals } };

    render(<BookmapView market={market} layout={defaultLayout} viewWindow={defaultWindow(5)} onWindow={() => undefined} onReading={() => undefined} />);

    expect(arcs.filter((radius) => radius === 4.5)).toHaveLength(41);
  });

  it("should draw in-window dots older than one hundred of one kind when a reloaded snapshot restores them", () => {
    const historyMinutes = 5;
    const span = historyMinutes * 60_000;
    const endMs = base.serverTimeMs + span * LIVE_EDGE_PAD;
    const startMs = endMs - span;
    const count = 150;
    const fixture = snapshotFixture();
    const signals = Array.from({ length: count }, (_, index) => event(index + 1, startMs + 1 + index, 100));
    const reloaded = fromSnapshot(
      { ...fixture, orderFlow: { ...fixture.orderFlow, signals } } satisfies Snapshot,
      historyMinutes,
      0,
    );

    render(
      <BookmapView
        market={{ ...reloaded, prints: [] }}
        layout={defaultLayout}
        viewWindow={defaultWindow(historyMinutes)}
        onWindow={() => undefined}
        onReading={() => undefined}
      />,
    );

    expect(reloaded.orderFlow.signals).toHaveLength(count);
    expect(reloaded.orderFlow.signals[0]?.id).toBe(1);
    expect(arcs.filter((radius) => radius === 4.5)).toHaveLength(count);
  });

  it("should keep the event tooltip and the cursor price when the pointer is also on the price line", () => {
    const barT = Math.floor((base.serverTimeMs - 60_000) / 60_000) * 60_000;
    const signalTime = barT + 30_000;
    const held = base.minuteBars[0] ?? base.bars[0];
    if (!held) throw new Error("the snapshot fixture has no bar");
    const bar = { ...held, t: barT, d: 60_000, o: 100, h: 500, l: 100, c: 100 };
    const market = {
      ...base,
      minuteBars: [bar],
      developingMinute: null,
      bars: [],
      developingBar: null,
      minuteHeat: [],
      developingMinuteHeat: null,
      heat: [],
      prints: [],
      ladder: { bids: [], asks: [] },
      profiles: [],
      vwap: { ...base.vwap, vwap: null },
      liquidity: { ...base.liquidity, bestBid: null, bestAsk: null },
      orderFlow: { ...base.orderFlow, keyLevels: [], signals: [event(1, signalTime, 104)], footprints: [], developingFootprint: null },
    };
    const frame = bookmapFrame(800, 400);
    const range = fitRange([500, 100]);
    if (!range) throw new Error("the candle has no price range");
    const span = 5 * 60_000;
    const endMs = base.serverTimeMs + span * LIVE_EDGE_PAD;
    const scales = bookmapScales(frame, endMs - span, endMs, range.low, range.high);
    expect(pointerOnPriceLine(104, 100, range, frame.plot.h)).toBe(true);

    render(<BookmapView market={market} layout={defaultLayout} viewWindow={defaultWindow(5)} onWindow={() => undefined} onReading={() => undefined} />);
    const stage = screen.getByLabelText(`Order Flow ${base.root}`).querySelector(".bookmap-stage");
    if (!(stage instanceof HTMLElement)) throw new Error("the Order Flow stage is missing");
    fireEvent.pointerMove(stage, { clientX: scales.time.toPx(signalTime), clientY: scales.price.toPx(104), pointerId: 1 });

    const price = [...screen.getByLabelText("Order Flow readout").querySelectorAll("div")].find((item) => item.querySelector("dt")?.textContent === "Price");
    expect(screen.getByRole("tooltip").textContent).toContain("Stacked imbalance");
    expect(price?.querySelector("dd")?.textContent).toBe(formatTicks(104, base.instrument));
    expect(price?.querySelector("dd")?.textContent).not.toBe(formatTicks(100, base.instrument));
  });
});

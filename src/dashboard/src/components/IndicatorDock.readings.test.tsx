// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultLayout, type IndicatorPaneId } from "../domain/layout.ts";
import { fromSnapshot, type IndicatorSeries, type MarketState } from "../domain/merge.ts";
import { createCrosshairStore } from "../hooks/crosshair.ts";
import { fakeSurface, type CanvasCall } from "../test/fakeCanvas.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { colors } from "../theme.ts";
import { IndicatorDock } from "./IndicatorDock.tsx";

// The MACD, RSI and ATR headers name each value they show, so two bare numbers no longer leave the reader guessing
// which is the line and which the signal (REQUIREMENTS.md FR-19, FR-20, FR-21).

vi.mock("../hooks/useElementSize.ts", () => ({ useElementSize: () => ({ width: 800, height: 200 }) }));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

const base = fromSnapshot(snapshotFixture(), 5, 0);
const now = base.serverTimeMs;
const spec = base.instrument;
const price = (ticks: number) => (ticks * spec.tickSize).toFixed(spec.priceDecimals);

// Synthetic closed values in ticks: MACD [t, line, signal, histogram], RSI and ATR [t, value].
const macd: IndicatorSeries = {
  id: "macd",
  label: "MACD 12/26/9",
  kind: "macd",
  tf: 60,
  warmup: 34,
  seen: 40,
  ready: true,
  points: [
    [now - 120_000, 3, 1, 2],
    [now - 60_000, 6, 2, 4],
  ],
  dev: null,
};
const rsi: IndicatorSeries = { id: "rsi14", label: "RSI 14", kind: "rsi", tf: 60, warmup: 15, seen: 40, ready: true, points: [[now - 60_000, 61.27]], dev: null };
const atr: IndicatorSeries = { id: "atr14", label: "ATR 14", kind: "atr", tf: 60, warmup: 15, seen: 40, ready: true, points: [[now - 60_000, 9]], dev: null };
const market: MarketState = { ...base, indicators: [macd, rsi, atr] };

let recordings: CanvasCall[][] = [];

beforeEach(() => {
  recordings = [];
  HTMLCanvasElement.prototype.getContext = (() => {
    const fake = fakeSurface(800, 200);
    recordings.push(fake.calls);
    return fake.surface.ctx;
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  cleanup();
});

function renderDock(pane: IndicatorPaneId, indicators: readonly IndicatorSeries[] = market.indicators) {
  render(
    <IndicatorDock
      market={{ ...market, indicators }}
      layout={{ ...defaultLayout, indicatorPane: pane }}
      candles={[]}
      indicators={indicators}
      startMs={now - 240_000}
      endMs={now}
      crosshair={createCrosshairStore()}
      showSinglePrints
    />,
  );
}

/** The header chip's text and ink, as the pane drew it. */
function header(): { readonly text: unknown; readonly ink: unknown } {
  const call = (recordings[0] ?? []).filter((c) => c.method === "fillText").at(-1);
  return { text: call?.args[0], ink: call?.fillStyle };
}

describe("IndicatorDock headers", () => {
  it("should name the MACD line, signal and histogram, Hist on the chip and Histogram in the summary, when MACD is ready", () => {
    renderDock("macd");

    const values = (histogram: string) => `Line ${price(6)} · Signal ${price(2)} · ${histogram} ${price(4)}`;
    expect(header()).toEqual({ text: `MACD 12/26/9  ${values("Hist")}`, ink: colors.text });
    // The summary is visually hidden, so it always fits and spells the word out.
    expect(screen.getByText(`MACD 12/26/9 ${values("Histogram")}`)).toBeTruthy();
  });

  it("should name the developing MACD values when the series carries them", () => {
    renderDock("macd", [{ ...macd, dev: [8, 3, 5] }, rsi, atr]);

    expect(header().text).toBe(`MACD 12/26/9  Line ${price(8)} · Signal ${price(3)} · Hist ${price(5)}`);
  });

  it("should name the RSI value when RSI is ready", () => {
    renderDock("rsi14");

    expect(header()).toEqual({ text: "RSI 14  Value 61.3", ink: colors.text });
    expect(screen.getByText("RSI 14 Value 61.3")).toBeTruthy();
  });

  it("should name the ATR value when ATR is ready", () => {
    renderDock("atr14");

    expect(header()).toEqual({ text: `ATR 14  Value ${price(9)}`, ink: colors.text });
    expect(screen.getByText(`ATR 14 Value ${price(9)}`)).toBeTruthy();
  });

  it("should still say warming up and name no value when MACD is not ready", () => {
    renderDock("macd", [{ ...macd, ready: false, seen: 20 }, rsi, atr]);

    expect(header()).toEqual({ text: "MACD 12/26/9  warming up (20/34)", ink: colors.muted });
    expect(screen.getByText("MACD 12/26/9 warming up (20/34)")).toBeTruthy();
  });
});

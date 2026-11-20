// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Regime } from "../api/schemas.ts";
import { defaultLayout } from "../domain/layout.ts";
import { fromSnapshot } from "../domain/merge.ts";
import { defaultWindow } from "../domain/viewWindow.ts";
import { createCrosshairStore } from "../hooks/crosshair.ts";
import { regimeFixture, snapshotFixture } from "../test/fixtures.ts";
import { MarketView } from "./MarketView.tsx";

// Detail's Conditions section reads the snapshot's closed indicators and book, and the polled summary's regimes.

const market = fromSnapshot(snapshotFixture(), 5, 0);
const noop = () => undefined;

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  cleanup();
});

function renderView(regimes?: readonly Regime[]) {
  render(
    <MarketView
      market={market}
      layout={defaultLayout}
      viewWindow={defaultWindow(5)}
      crosshair={createCrosshairStore()}
      onWindow={noop}
      onResetWindow={noop}
      onTogglePane={noop}
      onToggleKind={noop}
      regimes={regimes}
    />,
  );
}

function reading(name: string): string {
  const row = within(screen.getByRole("region", { name: "Conditions" }))
    .getAllByRole("listitem")
    .find((element) => element.querySelector(".name")?.textContent === name);
  return row?.querySelector("[data-reading]")?.textContent ?? `no row ${name}`;
}

describe("MarketView conditions", () => {
  it("should read the snapshot's closed indicators and its book when Detail shows a product", () => {
    renderView();

    // The synthetic snapshot: EMA 13 under EMA 48, RSI 36, MACD under its signal, VWAP inside a wide spread.
    expect(reading("EMA 13 vs EMA 48")).toBe("below");
    expect(reading("RSI 14 vs 50")).toBe("below");
    expect(reading("MACD vs its signal line")).toBe("below");
    expect(reading("Price vs VWAP")).toBe("at");
  });

  it("should read each regime from the summary it is given, and none when it is given none", () => {
    renderView([regimeFixture(300, { trend: "TrendingDown" }), regimeFixture(900, { ready: false, trend: "Unknown", seenBars: 3, warmupBars: 28 })]);

    expect(reading("5m regime")).toBe("trending down");
    expect(reading("15m regime")).toBe("warming 3/28");
    cleanup();

    renderView();

    expect(reading("5m regime")).toBe("not published");
  });
});

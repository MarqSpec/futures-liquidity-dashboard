// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Footprint } from "../api/schemas.ts";
import { defaultLayout, type LayoutSettings } from "../domain/layout.ts";
import { fromSnapshot, type MarketState } from "../domain/merge.ts";
import { formatChicagoTime } from "../domain/format.ts";
import { defaultWindow } from "../domain/viewWindow.ts";
import { createCrosshairStore, type CrosshairStore } from "../hooks/crosshair.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { FOOTPRINT_DELTA_STRIP } from "./drawFootprint.ts";
import { TIME_AXIS_HEIGHT } from "./drawMainChart.ts";
import { MarketView } from "./MarketView.tsx";

// Detail's main chart is the footprint by default, with a saved switch back to the price chart.

vi.mock("../hooks/useElementSize.ts", () => ({ useElementSize: () => ({ width: 800, height: 600 }) }));

const base = fromSnapshot(snapshotFixture(), 5, 0);

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  HTMLCanvasElement.prototype.getContext = (() => {
    const state: Record<string | symbol, unknown> = { fillStyle: "#000" };
    return new Proxy(state, {
      get(target, key) {
        if (key in target) return target[key];
        if (key === "measureText") return () => ({ width: 12 });
        if (key === "createPattern") return () => null;
        return () => undefined;
      },
      set(target, key, value) {
        target[key] = value;
        return true;
      },
    });
  }) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  cleanup();
});

let seenLayout: LayoutSettings = defaultLayout;

function Host({ shown = base, start = defaultLayout, crosshair = createCrosshairStore() }: { readonly shown?: MarketState; readonly start?: LayoutSettings; readonly crosshair?: CrosshairStore }) {
  const [layout, setLayout] = useState<LayoutSettings>(start);
  useEffect(() => {
    seenLayout = layout;
  });
  return (
    <MarketView
      market={shown}
      layout={layout}
      viewWindow={defaultWindow(shown.historyMinutes)}
      crosshair={crosshair}
      onWindow={() => undefined}
      onResetWindow={() => undefined}
      onTogglePane={() => undefined}
      onToggleKind={() => undefined}
      onReading={(change) => setLayout((current) => change(current))}
    />
  );
}

function pressed(name: string): string | null {
  return screen.getByRole("button", { name }).getAttribute("aria-pressed");
}

function priceAt(crosshair: CrosshairStore, y: number): number {
  const canvas = document.querySelector(".pane-overlay-interactive");
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("the overlay canvas is missing");
  const event = new PointerEvent("pointermove", { bubbles: true, pointerId: 9 });
  Object.defineProperty(event, "offsetX", { value: 400 });
  Object.defineProperty(event, "offsetY", { value: y });
  fireEvent(canvas, event);
  const price = crosshair.get().priceTicks;
  if (price === null) throw new Error("the pointer is not on the plot");
  return price;
}

function readout(): string {
  return document.querySelector(".chart-readout")?.textContent ?? "";
}

function footprintBar(t: number, low: number, high: number): Footprint {
  return { t, d: 60_000, o: low, h: high, l: low, cl: high, v: 10, delta: 2, maxDelta: 2, minDelta: 0, c: [low, 4, 6, 0, high, 3, 5, 0] };
}

describe("MarketView main chart", () => {
  it("should open on the footprint with the depth ladder beside it when the layout names no chart", () => {
    render(<Host />);

    expect(screen.getByRole("region", { name: "Footprint" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Price, liquidity and order flow" })).toBeNull();
    expect(screen.getByRole("group", { name: "Main chart" })).toBeTruthy();
    expect(pressed("Footprint")).toBe("true");
    expect(pressed("Price")).toBe("false");
    const side = screen.getByRole("complementary", { name: "Depth, liquidity and signals" });
    expect(side.innerHTML).toContain("Depth ladder");
    expect(screen.getByRole("application").getAttribute("aria-label")).toContain("footprint");
  });

  it("should show the price chart and save the choice when the viewer switches to Price, and come back on Footprint", async () => {
    const user = userEvent.setup();
    render(<Host />);

    await user.click(screen.getByRole("button", { name: "Price" }));

    expect(seenLayout.detailChart).toBe("price");
    expect(pressed("Price")).toBe("true");
    expect(screen.getByRole("region", { name: "Price, liquidity and order flow" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Footprint" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Footprint" }));

    expect(seenLayout.detailChart).toBe("footprint");
    expect(screen.getByRole("region", { name: "Footprint" })).toBeTruthy();
  });

  it("should start on the price chart when the saved layout names it", () => {
    render(<Host start={{ ...defaultLayout, detailChart: "price" }} />);

    expect(pressed("Price")).toBe("true");
    expect(screen.getByRole("region", { name: "Price, liquidity and order flow" })).toBeTruthy();
  });

  it("should keep the price controls beside either chart when the viewer switches", async () => {
    const user = userEvent.setup();
    render(<Host />);
    expect(screen.getByRole("group", { name: "Price" }).querySelectorAll("button")).toHaveLength(5);

    await user.click(screen.getByRole("button", { name: "Price" }));

    expect(screen.getByRole("group", { name: "Price" }).querySelectorAll("button")).toHaveLength(5);
  });

  it("should read the traded footprint cell under the keyboard cursor, not the resting depth, and step by footprint column at a 5-minute interval", async () => {
    const user = userEvent.setup();
    const closedT = base.serverTimeMs - 120_000;
    const formingT = base.serverTimeMs - 60_000;
    const shown: MarketState = {
      ...base,
      orderFlow: {
        ...base.orderFlow,
        footprints: [footprintBar(closedT, 27_398, 27_404)],
        developingFootprint: footprintBar(formingT, 27_399, 27_406),
      },
    };
    render(<Host shown={shown} start={{ ...defaultLayout, chartMinutes: 5 }} />);

    act(() => screen.getByRole("application").focus());
    expect(readout()).toContain("traded bid 3 × ask 5");
    expect(readout()).toContain(formatChicagoTime(formingT));
    expect(readout()).not.toMatch(/coverage|OHLC/);

    await user.keyboard("{ArrowLeft}");
    expect(readout()).toContain(formatChicagoTime(closedT));
    expect(readout()).toContain("no trades at this price");

    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(readout()).toContain("traded bid 3 × ask 5");
    expect(readout()).toContain(formatChicagoTime(closedT));
  });

  it("should read the footprint cell under the pointer when the viewer hovers the footprint chart", () => {
    const shown: MarketState = {
      ...base,
      orderFlow: { ...base.orderFlow, footprints: [], developingFootprint: footprintBar(base.serverTimeMs - 60_000, 27_399, 27_406) },
    };
    const crosshair = createCrosshairStore();
    render(<Host shown={shown} crosshair={crosshair} />);

    const price = priceAt(crosshair, 120);

    expect(readout()).toContain(formatChicagoTime(base.serverTimeMs - 60_000));
    expect(readout()).toMatch(/traded bid \d+ × ask \d+|no trades at this price/);
    expect(readout()).not.toMatch(/coverage|OHLC/);
    expect(Number.isFinite(price)).toBe(true);
  });

  it("should keep the price chart's candle and depth readout when the price chart is shown", () => {
    render(<Host start={{ ...defaultLayout, detailChart: "price" }} />);

    act(() => screen.getByRole("application").focus());

    expect(readout()).toContain("OHLC");
  });

  it("should fit the footprint bars in view rather than every candle when the footprint is shown", () => {
    const narrow: MarketState = {
      ...base,
      liquidity: { ...base.liquidity, bestBid: 27_400, bestAsk: 27_401 },
      orderFlow: {
        ...base.orderFlow,
        footprints: [footprintBar(base.serverTimeMs - 120_000, 27_398, 27_404)],
        developingFootprint: footprintBar(base.serverTimeMs - 60_000, 27_399, 27_406),
      },
    };
    const plotHeight = 600 - TIME_AXIS_HEIGHT - FOOTPRINT_DELTA_STRIP;

    const crosshair = createCrosshairStore();
    const footprint = render(<Host shown={narrow} crosshair={crosshair} />);
    const top = priceAt(crosshair, 0);
    const bottom = priceAt(crosshair, plotHeight);
    footprint.unmount();

    expect(top).toBeGreaterThanOrEqual(27_406);
    expect(top).toBeLessThan(27_420);
    expect(bottom).toBeLessThanOrEqual(27_398);
    expect(bottom).toBeGreaterThan(27_385);

    const priceCrosshair = createCrosshairStore();
    render(<Host shown={narrow} start={{ ...defaultLayout, detailChart: "price" }} crosshair={priceCrosshair} />);
    expect(priceAt(priceCrosshair, 0) - priceAt(priceCrosshair, 600 - TIME_AXIS_HEIGHT)).toBeGreaterThan(400);
  });
});

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bookmapFrame } from "../domain/bookmap.ts";
import { aggregateCandles } from "../domain/candles.ts";
import { formatLocalTime, formatTicks } from "../domain/format.ts";
import { defaultLayout, type LayoutSettings } from "../domain/layout.ts";
import { fromSnapshot, type MarketState } from "../domain/merge.ts";
import { defaultWindow, type ViewWindow } from "../domain/viewWindow.ts";
import { createCrosshairStore, type CrosshairStore } from "../hooks/crosshair.ts";
import { fakeSurface } from "../test/fakeCanvas.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { BookmapView } from "./BookmapView.tsx";
import { MarketView } from "./MarketView.tsx";

// Order Flow shows Detail's indicator dock below its chart, in place of its volume strip and CVD subchart.

// Every measured box is 800×600, so the stage, the dock's panes and their canvases have pixels to work with.
vi.mock("../hooks/useElementSize.ts", () => ({ useElementSize: () => ({ width: 800, height: 600 }) }));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

const market = fromSnapshot(snapshotFixture(), 5, 0);
const frame = bookmapFrame(800, 600);

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = (() => fakeSurface(800, 600).surface.ctx) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function stage(): HTMLElement {
  return screen.getByTitle(/Shift\+wheel zooms price/);
}

function dock(): HTMLElement {
  const found = document.querySelector(".indicator-dock");
  if (!(found instanceof HTMLElement)) throw new Error("the indicator dock is missing");
  return found;
}

// Two minutes of the five loaded, so a drag has older history to pan into.
const twoMinutes: ViewWindow = { spanMs: 120_000, offsetMs: 0, priceZoom: 1 };

function OrderFlow({
  initial = defaultLayout,
  crosshair,
  shown = market,
}: {
  readonly initial?: LayoutSettings;
  readonly crosshair?: CrosshairStore;
  readonly shown?: MarketState;
}) {
  const [layout, setLayout] = useState(initial);
  const [view, setView] = useState<ViewWindow>(twoMinutes);
  return (
    <>
      <output data-testid="saved">{`${layout.indicatorPane}:${layout.indicatorDockCollapsed ? "collapsed" : "expanded"}`}</output>
      <output data-testid="window">{`${view.spanMs}:${view.offsetMs}`}</output>
      <BookmapView
        market={shown}
        layout={layout}
        viewWindow={view}
        crosshair={crosshair}
        onWindow={(change) => setView((current) => change(current))}
        onReading={(change) => setLayout((current) => change(current))}
      />
    </>
  );
}

describe("BookmapView indicator dock", () => {
  it("should show Detail's dock below the chart, with its six tabs and collapse button, and no strip or CVD toggle in Display", async () => {
    const user = userEvent.setup();
    render(<OrderFlow />);

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Volume", "CVD", "RSI", "MACD", "ATR", "TPO"]);
    expect(screen.getByRole("button", { name: "Indicator dock" }).getAttribute("aria-expanded")).toBe("true");
    // Under the chart and above the readout, where the strip and the subchart were drawn.
    expect(stage().compareDocumentPosition(dock()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dock().compareDocumentPosition(screen.getByLabelText("Order Flow readout")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Display" }));
    expect(screen.getByRole("button", { name: "Event key" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Bottom Volume Strip" })).toBeNull();
    expect(screen.queryByRole("button", { name: "CVD Subchart" })).toBeNull();
  });

  it("should open on the tab and collapsed state the layout names and save the viewer's change to them", async () => {
    const user = userEvent.setup();
    render(<OrderFlow initial={{ ...defaultLayout, indicatorPane: "rsi14", indicatorDockCollapsed: true }} />);

    expect(screen.getByRole("tab", { name: "RSI", selected: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Indicator dock" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "RSI 14" })).toBeNull();

    await user.click(screen.getByRole("tab", { name: "CVD" }));

    expect(screen.getByRole("region", { name: "Cumulative volume delta" })).toBeTruthy();
    expect(screen.getByTestId("saved").textContent).toBe("cvd:expanded");
  });

  it("should carry the dock's tab and collapsed state between Detail and Order Flow and keep them after a reload", async () => {
    const user = userEvent.setup();
    const crosshair = createCrosshairStore();
    let saved: LayoutSettings = defaultLayout;
    function Switch() {
      const [layout, setLayout] = useState(defaultLayout);
      const [tab, setTab] = useState<"detail" | "orderflow">("detail");
      const [view, setView] = useState<ViewWindow>(defaultWindow(5));
      const onReading = (change: (current: LayoutSettings) => LayoutSettings) =>
        setLayout((current) => {
          saved = change(current);
          return saved;
        });
      return (
        <>
          <button type="button" onClick={() => setTab(tab === "detail" ? "orderflow" : "detail")}>
            Switch tab
          </button>
          {tab === "detail" ? (
            <MarketView
              market={market}
              layout={layout}
              viewWindow={view}
              crosshair={crosshair}
              onWindow={(change) => setView((current) => change(current))}
              onResetWindow={() => setView(defaultWindow(5))}
              onTogglePane={() => undefined}
              onToggleKind={() => undefined}
              onReading={onReading}
            />
          ) : (
            <BookmapView market={market} layout={layout} viewWindow={view} crosshair={crosshair} onWindow={(change) => setView((current) => change(current))} onReading={onReading} />
          )}
        </>
      );
    }
    const first = render(<Switch />);

    await user.click(screen.getByRole("tab", { name: "MACD" }));
    await user.click(screen.getByRole("button", { name: "Switch tab" }));
    expect(screen.getByLabelText(`Order Flow ${market.root}`)).toBeTruthy();
    expect(screen.getByRole("tab", { name: "MACD", selected: true })).toBeTruthy();
    expect(screen.getByRole("region", { name: "MACD 12/26/9" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Indicator dock" }));
    await user.click(screen.getByRole("button", { name: "Switch tab" }));
    expect(screen.getByRole("toolbar", { name: "Detail chart controls" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "MACD", selected: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Indicator dock" }).getAttribute("aria-expanded")).toBe("false");

    first.unmount();
    render(<OrderFlow initial={saved} />);
    expect(screen.getByRole("tab", { name: "MACD", selected: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Indicator dock" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("should draw one Volume bar per Order Flow candle at the chart's interval, as the volume strip did", () => {
    const template = market.minuteBars.at(-1) ?? market.bars.at(-1);
    if (!template) throw new Error("the fixture has no bar");
    // Ten closed one-minute bars from a five-minute boundary: two five-minute candles.
    const from = Math.floor((market.serverTimeMs - 600_000) / 300_000) * 300_000 - 300_000;
    const minuteBars = Array.from({ length: 10 }, (_, i) => ({ ...template, t: from + i * 60_000, d: 60_000 }));
    const shown: MarketState = { ...market, minuteBars, developingMinute: null };
    render(<OrderFlow shown={shown} initial={{ ...defaultLayout, chartMinutes: 5, indicatorPane: "volume" }} />);
    const candles = aggregateCandles(minuteBars, null, market.serverTimeMs, 5 * 60_000);

    expect(candles).toHaveLength(2);
    expect(screen.getByRole("region", { name: "Volume" }).textContent).toBe("Traded volume of 2 bars, warmup bars without an aggressor side");
  });

  it("should keep the last print's size beside its price in the readout now the live CVD card under the dock columns is gone", () => {
    const priceTicks = Math.round(6890 / market.instrument.tickSize);
    const shown = {
      ...market,
      prints: [{ sourceTimeMs: market.serverTimeMs - 1_000, priceTicks, quantity: 3, aggressor: "Bid" as const, sequence: 1 }],
    };
    render(<BookmapView market={shown} layout={defaultLayout} viewWindow={defaultWindow(5)} onWindow={() => undefined} onReading={() => undefined} />);
    const row = [...screen.getByLabelText("Order Flow readout").querySelectorAll("div")].find((item) => item.querySelector("dt")?.textContent === "Last");

    const text = row?.querySelector("dd")?.textContent ?? "";
    const prefix = `${formatTicks(priceTicks, market.instrument)} × 3 · CVD `;

    expect(text.slice(0, prefix.length)).toBe(prefix);
    expect(text.length).toBeGreaterThan(prefix.length);
  });

  it("should put a time at the same x on the dock as on the plot before and after a drag and a wheel zoom, and not move either when the wheel gate leaves the wheel to the page", () => {
    const crosshair = createCrosshairStore();
    render(<OrderFlow crosshair={crosshair} initial={{ ...defaultLayout, indicatorPane: "cvd" }} />);
    const overlay = dock().querySelector(".pane-overlay");
    if (!(overlay instanceof HTMLCanvasElement)) throw new Error("the dock's pane overlay is missing");
    const x = frame.plot.x + 0.6 * frame.plot.w;

    const chartTime = () => {
      fireEvent.pointerMove(stage(), { clientX: x, clientY: 200, pointerId: 9 });
      const time = crosshair.get().timeMs;
      if (time === null) throw new Error("the pointer is not on the plot");
      // The shared crosshair carries the plot's own time: the readout shows the same instant.
      const row = [...screen.getByLabelText("Order Flow readout").querySelectorAll("div")].find((item) => item.querySelector("dt")?.textContent === "Time");
      expect(row?.querySelector("dd")?.textContent).toBe(formatLocalTime(time));
      fireEvent.pointerLeave(stage());
      return time;
    };
    const dockTime = () => {
      const event = new PointerEvent("pointermove", { bubbles: true, clientX: x, clientY: 40 });
      Object.defineProperty(event, "offsetX", { value: x });
      fireEvent(overlay, event);
      const time = crosshair.get().timeMs;
      if (time === null) throw new Error("the pointer is not on the dock's plot");
      return time;
    };
    const window = () => screen.getByTestId("window").textContent;

    const fitted = chartTime();
    expect(dockTime()).toBeCloseTo(fitted, 0);

    fireEvent.pointerDown(stage(), { button: 0, clientX: x, clientY: 200, pointerId: 4 });
    fireEvent.pointerMove(stage(), { clientX: x + 120, clientY: 200, pointerId: 4 });
    fireEvent.pointerUp(stage(), { clientX: x + 120, clientY: 200, pointerId: 4 });
    const panned = chartTime();
    expect(panned).toBeLessThan(fitted);
    expect(dockTime()).toBeCloseTo(panned, 0);

    act(() => {
      stage().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -40, clientX: 200, clientY: 200 }));
    });
    const zoomed = chartTime();
    expect(zoomed).not.toBeCloseTo(panned, 0);
    expect(dockTime()).toBeCloseTo(zoomed, 0);

    // A window shorter than the plot: the page can scroll, so the gate gives it the wheel and nothing zooms (D-53).
    vi.spyOn(globalThis, "innerHeight", "get").mockReturnValue(300);
    const before = window();
    const gated = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -40, clientX: 200, clientY: 200 });
    act(() => {
      stage().dispatchEvent(gated);
    });
    expect(gated.defaultPrevented).toBe(false);
    expect(window()).toBe(before);
    expect(chartTime()).toBeCloseTo(zoomed, 0);
    expect(dockTime()).toBeCloseTo(zoomed, 0);
  });
});

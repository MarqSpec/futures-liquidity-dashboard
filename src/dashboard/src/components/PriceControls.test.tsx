// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { bookmapFrame } from "../domain/bookmap.ts";
import { chartZoomIn, chartZoomOut } from "../domain/chartCursor.ts";
import { defaultLayout, type LayoutSettings } from "../domain/layout.ts";
import { fromSnapshot, type MarketState } from "../domain/merge.ts";
import { defaultWindow, type ViewWindow } from "../domain/viewWindow.ts";
import { createCrosshairStore } from "../hooks/crosshair.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { TIME_AXIS_HEIGHT } from "./drawMainChart.ts";
import { BookmapView } from "./BookmapView.tsx";
import { MarketView } from "./MarketView.tsx";

// — one set of price controls, on both tabs.

vi.mock("../hooks/useElementSize.ts", () => ({ useElementSize: () => ({ width: 800, height: 600 }) }));

const base = fromSnapshot(snapshotFixture(), 5, 0);
const fitted = defaultWindow(base.historyMinutes);
const crosshair = createCrosshairStore();

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  if (!HTMLCanvasElement.prototype.setPointerCapture) {
    HTMLCanvasElement.prototype.setPointerCapture = () => undefined;
    HTMLCanvasElement.prototype.releasePointerCapture = () => undefined;
  }
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

type Tab = "detail" | "orderflow";

// What the host last rendered, read back by the assertions.
let seenWindow: ViewWindow = defaultWindow(5);
let seenLayout: LayoutSettings = defaultLayout;

/** The dashboard's two chart tabs over one layout and one view window, as `DashboardRoute` mounts them. */
function Tabs({ shown, first, start = fitted, locked = false }: {
  readonly shown: MarketState;
  readonly first: Tab;
  readonly start?: ViewWindow;
  readonly locked?: boolean;
}) {
  const [tab, setTab] = useState<Tab>(first);
  // The price chart's plot middle is read below; MarketView.priceControls.test.tsx covers the footprint.
  const [layout, setLayout] = useState<LayoutSettings>({ ...defaultLayout, detailChart: "price", centerPrice: locked });
  const [view, setView] = useState<ViewWindow>(start);
  useEffect(() => {
    seenWindow = view;
    seenLayout = layout;
  });
  const onWindow = (change: (current: ViewWindow) => ViewWindow) => setView((current) => change(current));
  const onReading = (change: (current: LayoutSettings) => LayoutSettings) => setLayout((current) => change(current));
  return (
    <>
      <button type="button" onClick={() => setTab(tab === "detail" ? "orderflow" : "detail")}>
        Switch tab
      </button>
      {tab === "orderflow" ? (
        <BookmapView market={shown} layout={layout} viewWindow={view} onWindow={onWindow} onReading={onReading} />
      ) : (
        <MarketView
          market={shown}
          layout={layout}
          viewWindow={view}
          crosshair={crosshair}
          onWindow={onWindow}
          onResetWindow={() => setView(defaultWindow(shown.historyMinutes))}
          onTogglePane={() => undefined}
          onToggleKind={() => undefined}
          onReading={onReading}
        />
      )}
    </>
  );
}

function withPrint(priceTicks: number): MarketState {
  return {
    ...base,
    prints: [{ sourceTimeMs: base.serverTimeMs - 1_000, priceTicks, quantity: 1, aggressor: "Bid", sequence: 1 }],
  };
}

function lock(): string | null {
  return screen.getByRole("button", { name: "Lock center" }).getAttribute("aria-pressed");
}

/** The price drawn at the middle of the price plot, on whichever tab is shown. */
function middlePrice(tab: Tab): number {
  if (tab === "detail") {
    const canvas = document.querySelector(".pane-overlay-interactive");
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("the Detail overlay is missing");
    const y = (600 - TIME_AXIS_HEIGHT) / 2;
    const event = new PointerEvent("pointermove", { bubbles: true, clientX: 400, clientY: y, pointerId: 9 });
    Object.defineProperty(event, "offsetX", { value: 400 });
    Object.defineProperty(event, "offsetY", { value: y });
    fireEvent(canvas, event);
    const price = crosshair.get().priceTicks;
    if (price === null) throw new Error("the pointer is not on the Detail plot");
    return price;
  }
  const stage = screen.getByTitle(/Shift\+wheel zooms price/);
  fireEvent.pointerMove(stage, { clientX: 100, clientY: bookmapFrame(800, 600).plot.h / 2, pointerId: 9 });
  const row = [...screen.getByLabelText("Order Flow readout").querySelectorAll("div")].find((item) => item.querySelector("dt")?.textContent === "Price");
  return Number((row?.querySelector("dd")?.textContent ?? "").replace(/,/g, "")) / base.instrument.tickSize;
}

const tabs: readonly Tab[] = ["detail", "orderflow"];

describe("PriceControls on Detail and Order Flow", () => {
  it("should render the same Price group on both tabs", () => {
    render(<Tabs shown={withPrint(27_000)} first="detail" />);
    const detail = screen.getByRole("group", { name: "Price" }).outerHTML;

    fireEvent.click(screen.getByRole("button", { name: "Switch tab" }));

    expect(screen.getByRole("group", { name: "Price" }).outerHTML).toBe(detail);
  });

  it.each(tabs)("should write the same price zoom on %s when + and − are pressed", async (tab) => {
    const user = userEvent.setup();
    render(<Tabs shown={withPrint(27_000)} first={tab} start={{ ...fitted, priceZoom: 0.8 }} />);

    await user.click(screen.getByRole("button", { name: "Zoom price in" }));
    expect(seenWindow).toEqual({ ...fitted, priceZoom: 0.8 * chartZoomIn });

    await user.click(screen.getByRole("button", { name: "Zoom price out" }));
    expect(seenWindow.priceZoom).toBeCloseTo(0.8 * chartZoomIn * chartZoomOut, 10);
  });

  it.each(tabs)("should restore the default window and turn Lock off on %s when Fit is pressed", async (tab) => {
    const user = userEvent.setup();
    render(<Tabs shown={withPrint(27_000)} first={tab} start={{ spanMs: 120_000, offsetMs: 30_000, priceZoom: 0.5 }} locked />);

    await user.click(screen.getByRole("button", { name: "Fit" }));

    expect(seenWindow).toEqual(fitted);
    expect(seenLayout.centerPrice).toBe(false);
    expect(lock()).toBe("false");
  });

  it.each(tabs)("should put the last price in the middle on %s when Center is pressed", async (tab) => {
    const user = userEvent.setup();
    const shown = withPrint(0);
    const probe = render(<Tabs shown={shown} first={tab} />);
    const below = Math.round(middlePrice(tab)) - 8;
    probe.unmount();
    render(<Tabs shown={withPrint(below)} first={tab} />);

    await user.click(screen.getByRole("button", { name: "Center price" }));

    expect(middlePrice(tab)).toBeCloseTo(below, 0);
    expect(seenWindow.priceZoom).toBe(1);
  });

  it.each(tabs)("should show Lock on in the other tab when it is turned on in %s, and off again from there", async (tab) => {
    const user = userEvent.setup();
    render(<Tabs shown={withPrint(27_000)} first={tab} />);

    await user.click(screen.getByRole("button", { name: "Lock center" }));
    expect(seenLayout.centerPrice).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Switch tab" }));
    expect(lock()).toBe("true");

    await user.click(screen.getByRole("button", { name: "Lock center" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch tab" }));
    expect(lock()).toBe("false");
    expect(seenLayout.centerPrice).toBe(false);
  });

  it.each(tabs)("should keep Lock on in %s when Center is pressed", async (tab) => {
    const user = userEvent.setup();
    render(<Tabs shown={withPrint(27_000)} first={tab} locked />);

    await user.click(screen.getByRole("button", { name: "Center price" }));

    expect(lock()).toBe("true");
    expect(seenLayout.centerPrice).toBe(true);
  });

  it("should keep a saved Lock on when either tab opens", () => {
    render(<Tabs shown={withPrint(27_000)} first="detail" locked />);
    expect(lock()).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Switch tab" }));

    expect(lock()).toBe("true");
  });
});

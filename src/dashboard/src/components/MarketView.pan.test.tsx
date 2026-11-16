// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { bookmapFrame } from "../domain/bookmap.ts";
import { chartZoomIn } from "../domain/chartCursor.ts";
import { formatLocalTime } from "../domain/format.ts";
import { defaultLayout } from "../domain/layout.ts";
import { fromSnapshot, type MarketState } from "../domain/merge.ts";
import { LIVE_EDGE_PAD, MAX_PRICE_ZOOM, MIN_PRICE_ZOOM, zoomTimeAbout, type ViewWindow } from "../domain/viewWindow.ts";
import { createCrosshairStore, type CrosshairStore } from "../hooks/crosshair.ts";
import { AXIS_WIDTH, PROFILE_GUTTER } from "../theme.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import css from "../index.css?raw";
import { BookmapView } from "./BookmapView.tsx";
import { MarketView } from "./MarketView.tsx";

const base = fromSnapshot(snapshotFixture(), 5, 0);
const historyMs = base.historyMinutes * 60_000;
const initial: ViewWindow = { spanMs: 180_000, offsetMs: 0, priceZoom: 1 };
const plotLeft = PROFILE_GUTTER;
const plotRight = 800 - AXIS_WIDTH;
const anchorX = plotLeft + 0.35 * (plotRight - plotLeft);
const anchorY = 140;

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

function overlay(): HTMLCanvasElement {
  const canvas = document.querySelector(".pane-overlay-interactive");
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("the overlay canvas is missing");
  return canvas;
}

function pointer(type: string, x: number, y: number): PointerEvent {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0 });
  Object.defineProperty(event, "offsetX", { value: x });
  Object.defineProperty(event, "offsetY", { value: y });
  return event;
}

function wheel(x: number, y: number, deltaY = -40, shiftKey = false): WheelEvent {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY, shiftKey, clientX: x, clientY: y });
  Object.defineProperty(event, "offsetX", { value: x });
  Object.defineProperty(event, "offsetY", { value: y });
  return event;
}

function Probe({ crosshair }: { readonly crosshair: CrosshairStore }) {
  const [market, setMarket] = useState<MarketState>(base);
  const [view, setView] = useState<ViewWindow>(initial);
  return (
    <>
      <output data-testid="span">{view.spanMs}</output>
      <output data-testid="offset">{view.offsetMs}</output>
      <output data-testid="zoom">{view.priceZoom}</output>
      <button type="button" onClick={() => setMarket((current) => ({ ...current, serverTimeMs: current.serverTimeMs + 20_000 }))}>
        tick
      </button>
      <button type="button" onClick={() => setView((current) => ({ ...current, offsetMs: 0 }))}>
        Live
      </button>
      <MarketView
        market={market}
        layout={defaultLayout}
        viewWindow={view}
        crosshair={crosshair}
        onWindow={(change) => setView((current) => change(current))}
        onResetWindow={() => setView(initial)}
        onTogglePane={() => undefined}
        onToggleKind={() => undefined}
      />
    </>
  );
}

function readNumber(id: "span" | "offset" | "zoom"): number {
  return Number(screen.getByTestId(id).textContent);
}

function windowEnd(serverTimeMs: number, spanMs: number, offsetMs: number): number {
  return serverTimeMs + LIVE_EDGE_PAD * spanMs - offsetMs;
}

function timeAtPointer(crosshair: CrosshairStore): number {
  fireEvent(overlay(), pointer("pointermove", anchorX, anchorY));
  const time = crosshair.get().timeMs;
  if (time === null) throw new Error("the pointer is not on the plot");
  return time;
}

describe("MarketView plot pan and wheel", () => {
  it("should keep the instant under the pointer when several wheel notches update real state", () => {
    const fraction = (anchorX - plotLeft) / (plotRight - plotLeft);
    let span = initial.spanMs;
    let offset = 0;
    const anchor = windowEnd(base.serverTimeMs, span, 0) - span + fraction * span;
    render(<Probe crosshair={createCrosshairStore()} />);
    const canvas = overlay();

    act(() => {
      for (let notch = 0; notch < 4; notch += 1) canvas.dispatchEvent(wheel(anchorX, anchorY));
    });

    for (let notch = 0; notch < 4; notch += 1) {
      const placed = zoomTimeAbout(span, offset, fraction, chartZoomIn, historyMs);
      span = placed.spanMs;
      offset = placed.offsetMs;
    }
    const shownSpan = readNumber("span");
    const shownOffset = readNumber("offset");
    const shownEnd = windowEnd(base.serverTimeMs, shownSpan, shownOffset);

    expect(shownSpan).toBeCloseTo(span, 4);
    expect(shownSpan).toBeLessThan(initial.spanMs * chartZoomIn);
    expect(shownEnd - shownSpan + fraction * shownSpan).toBeCloseTo(anchor, 3);
    expect(shownSpan).toBeGreaterThanOrEqual(60_000);
    expect(shownSpan).toBeLessThanOrEqual(historyMs);
  });

  it("should keep a fixed lag behind live after a time pan and catch up from Live", () => {
    const crosshair = createCrosshairStore();
    render(<Probe crosshair={crosshair} />);
    const before = timeAtPointer(crosshair);

    fireEvent.click(screen.getByRole("button", { name: "tick" }));
    const followed = timeAtPointer(crosshair);
    expect(followed - before).toBeCloseTo(20_000, 0);

    const canvas = overlay();
    fireEvent(canvas, pointer("pointerdown", anchorX, anchorY));
    fireEvent(canvas, pointer("pointermove", anchorX + 80, anchorY));
    fireEvent(canvas, pointer("pointerup", anchorX + 80, anchorY));
    const offset = readNumber("offset");
    expect(offset).toBeGreaterThan(0);
    const parked = timeAtPointer(crosshair);

    fireEvent.click(screen.getByRole("button", { name: "tick" }));
    expect(timeAtPointer(crosshair) - parked).toBeCloseTo(20_000, 0);
    expect(readNumber("offset")).toBeCloseTo(offset, 0);

    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    expect(readNumber("offset")).toBe(0);
    expect(timeAtPointer(crosshair) - parked - 20_000).toBeCloseTo(offset, -1);
  });

  it("should show the same time window on Order Flow after a Detail pan leaves live", () => {
    const crosshair = createCrosshairStore();
    function Switch() {
      const [flow, setFlow] = useState(false);
      const [view, setView] = useState(initial);
      return (
        <>
          <button type="button" onClick={() => setFlow(true)}>
            Order Flow
          </button>
          <output data-testid="shared-span">{view.spanMs}</output>
          <output data-testid="shared-offset">{view.offsetMs}</output>
          {flow ? (
            <BookmapView market={base} layout={defaultLayout} viewWindow={view} onReading={() => undefined} onWindow={(change) => setView(change)} />
          ) : (
            <MarketView
              market={base}
              layout={defaultLayout}
              viewWindow={view}
              crosshair={crosshair}
              onWindow={(change) => setView(change)}
              onResetWindow={() => setView(initial)}
              onTogglePane={() => undefined}
              onToggleKind={() => undefined}
            />
          )}
        </>
      );
    }
    render(<Switch />);
    const canvas = overlay();
    fireEvent(canvas, pointer("pointerdown", anchorX, anchorY));
    fireEvent(canvas, pointer("pointermove", anchorX + 100, anchorY));
    fireEvent(canvas, pointer("pointerup", anchorX + 100, anchorY));
    const span = Number(screen.getByTestId("shared-span").textContent);
    const offset = Number(screen.getByTestId("shared-offset").textContent);
    expect(offset).toBeGreaterThan(0);

    const fraction = (anchorX - plotLeft) / (plotRight - plotLeft);
    const detailTime = timeAtPointer(crosshair);
    const expected = windowEnd(base.serverTimeMs, span, offset) - span + fraction * span;
    expect(detailTime).toBeCloseTo(expected, 0);

    fireEvent.click(screen.getByRole("button", { name: "Order Flow" }));
    const frame = bookmapFrame(800, 400, { volume: true, cvd: true });
    const stage = screen.getByLabelText(`Order Flow ${base.root}`).querySelector(".bookmap-stage");
    if (!(stage instanceof HTMLElement)) throw new Error("the Order Flow stage is missing");
    fireEvent.pointerMove(stage, { clientX: frame.plot.x + fraction * frame.plot.w, clientY: 40, pointerId: 3 });
    const orderFlowTime = screen.getByLabelText("Order Flow readout").textContent ?? "";

    expect(orderFlowTime).toContain(formatLocalTime(expected));
    expect(orderFlowTime).toContain(formatLocalTime(detailTime));
  });

  it("should show higher prices after a downward drag and fit them again on double-click", () => {
    const crosshair = createCrosshairStore();
    render(<Probe crosshair={crosshair} />);
    fireEvent(overlay(), pointer("pointermove", anchorX, anchorY));
    const before = crosshair.get().priceTicks;
    if (before === null) throw new Error("the pointer is not on the plot");

    const canvas = overlay();
    fireEvent(canvas, pointer("pointerdown", anchorX, anchorY));
    fireEvent(canvas, pointer("pointermove", anchorX, anchorY + 90));
    fireEvent(canvas, pointer("pointerup", anchorX, anchorY + 90));
    fireEvent(canvas, pointer("pointermove", anchorX, anchorY));
    const dragged = crosshair.get().priceTicks;
    if (dragged === null) throw new Error("the pointer left the plot");
    expect(dragged).toBeGreaterThan(before);

    fireEvent.doubleClick(canvas);
    fireEvent(canvas, pointer("pointermove", anchorX, anchorY));
    expect(crosshair.get().priceTicks).toBeCloseTo(before, 4);
  });

  it("should fit the price again when the instrument returns without another drag", () => {
    const crosshair = createCrosshairStore();
    const view = initial;
    const host = render(
      <MarketView
        market={base}
        layout={defaultLayout}
        viewWindow={view}
        crosshair={crosshair}
        onWindow={() => undefined}
        onResetWindow={() => undefined}
        onTogglePane={() => undefined}
        onToggleKind={() => undefined}
      />,
    );
    const priceAt = () => {
      fireEvent(overlay(), pointer("pointermove", anchorX, anchorY));
      const price = crosshair.get().priceTicks;
      if (price === null) throw new Error("the pointer is not on the plot");
      return price;
    };
    const fitted = priceAt();
    const canvas = overlay();
    fireEvent(canvas, pointer("pointerdown", anchorX, anchorY));
    fireEvent(canvas, pointer("pointermove", anchorX, anchorY + 90));
    fireEvent(canvas, pointer("pointerup", anchorX, anchorY + 90));
    const dragged = priceAt();
    expect(dragged).toBeGreaterThan(fitted);

    const elsewhere = { ...base, root: "MCL" };
    host.rerender(
      <MarketView
        market={elsewhere}
        layout={defaultLayout}
        viewWindow={view}
        crosshair={crosshair}
        onWindow={() => undefined}
        onResetWindow={() => undefined}
        onTogglePane={() => undefined}
        onToggleKind={() => undefined}
      />,
    );
    host.rerender(
      <MarketView
        market={base}
        layout={defaultLayout}
        viewWindow={view}
        crosshair={crosshair}
        onWindow={() => undefined}
        onResetWindow={() => undefined}
        onTogglePane={() => undefined}
        onToggleKind={() => undefined}
      />,
    );

    expect(priceAt()).toBeCloseTo(fitted, 4);
  });

  it("should keep price zoom inside the clamp after a vertical drag and many shift-wheel notches", () => {
    const crosshair = createCrosshairStore();
    render(<Probe crosshair={crosshair} />);
    const spanOf = () => {
      fireEvent(overlay(), pointer("pointermove", anchorX, 20));
      const high = crosshair.get().priceTicks;
      fireEvent(overlay(), pointer("pointermove", anchorX, 360));
      const low = crosshair.get().priceTicks;
      if (high === null || low === null) throw new Error("the pointer is not on the plot");
      return Math.abs(high - low);
    };
    const before = spanOf();
    const canvas = overlay();
    fireEvent(canvas, pointer("pointerdown", anchorX, anchorY));
    fireEvent(canvas, pointer("pointermove", anchorX, anchorY + 10));
    fireEvent(canvas, pointer("pointerup", anchorX, anchorY + 10));

    act(() => {
      for (let notch = 0; notch < 60; notch += 1) canvas.dispatchEvent(wheel(anchorX, anchorY, 40, true));
    });
    const widened = spanOf();
    expect(widened / before).toBeCloseTo(MAX_PRICE_ZOOM, 4);
    expect(readNumber("zoom")).toBe(MAX_PRICE_ZOOM);

    act(() => {
      for (let notch = 0; notch < 80; notch += 1) canvas.dispatchEvent(wheel(anchorX, anchorY, -40, true));
    });
    const tightened = spanOf();
    expect(tightened / before).toBeCloseTo(MIN_PRICE_ZOOM, 4);
    expect(readNumber("zoom")).toBe(MIN_PRICE_ZOOM);
  });

  it("should let the page scroll when the time span is already the whole history", () => {
    render(<Probe crosshair={createCrosshairStore()} />);
    const canvas = overlay();
    for (let notch = 0; notch < 12; notch += 1) fireEvent(canvas, wheel(anchorX, anchorY, 120, false));
    expect(readNumber("span")).toBe(historyMs);

    const stuck = wheel(anchorX, anchorY, 120, false);
    fireEvent(canvas, stuck);

    expect(stuck.defaultPrevented).toBe(false);
    expect(readNumber("span")).toBe(historyMs);
  });

  it("should set touch-action none on the plot overlay", () => {
    render(<Probe crosshair={createCrosshairStore()} />);

    expect(overlay().className).toContain("pane-overlay-interactive");
    expect(css).toMatch(/\.pane-overlay-interactive\s*\{[^}]*touch-action:\s*none/);
  });
});

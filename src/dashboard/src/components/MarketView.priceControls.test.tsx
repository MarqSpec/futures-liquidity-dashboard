// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { CENTER_FOLLOW_MS, LOCK_RELEASE_DRAG_PX, PINCH_AXIS_MIN_PX } from "../domain/bookmap.ts";
import { chartZoomIn, chartZoomOut } from "../domain/chartCursor.ts";
import { defaultLayout, type LayoutSettings } from "../domain/layout.ts";
import { fromSnapshot, type MarketState } from "../domain/merge.ts";
import { defaultWindow, type ViewWindow } from "../domain/viewWindow.ts";
import { createCrosshairStore, type CrosshairStore } from "../hooks/crosshair.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { TIME_AXIS_HEIGHT } from "./drawMainChart.ts";
import { MarketView } from "./MarketView.tsx";


vi.mock("../hooks/useElementSize.ts", () => ({ useElementSize: () => ({ width: 800, height: 600 }) }));

const base = fromSnapshot(snapshotFixture(), 5, 0);
const fitted = defaultWindow(base.historyMinutes);
const plotX = 400;
const plotMidY = (600 - TIME_AXIS_HEIGHT) / 2;
const lockTitle = "Keep the last price in the middle. A vertical drag or a price zoom, including + and −, turns this off. A sideways drag does not.";

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
  vi.useRealTimers();
});

function overlay(): HTMLCanvasElement {
  const canvas = document.querySelector(".pane-overlay-interactive");
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("the overlay canvas is missing");
  return canvas;
}

function pointer(type: string, x: number, y: number, pointerId = 1, pointerType = "mouse"): PointerEvent {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId, button: 0, pointerType });
  Object.defineProperty(event, "offsetX", { value: x });
  Object.defineProperty(event, "offsetY", { value: y });
  return event;
}

function wheel(deltaY: number, shiftKey: boolean): WheelEvent {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY, shiftKey, clientX: plotX, clientY: plotMidY });
  Object.defineProperty(event, "offsetX", { value: plotX });
  Object.defineProperty(event, "offsetY", { value: plotMidY });
  return event;
}

/** The price under a hover at `y`, read from the shared crosshair. A hover uses its own pointer, so it never drags. */
function priceAt(crosshair: CrosshairStore, y: number): number {
  fireEvent(overlay(), pointer("pointermove", plotX, y, 9));
  const price = crosshair.get().priceTicks;
  if (price === null) throw new Error("the pointer is not on the plot");
  return price;
}

function withPrint(priceTicks: number, shown: MarketState = base): MarketState {
  return {
    ...shown,
    prints: [{ sourceTimeMs: shown.serverTimeMs - 1_000, priceTicks, quantity: 1, aggressor: "Bid", sequence: 1 }],
  };
}

function lock(): string | null {
  return screen.getByRole("button", { name: "Lock center" }).getAttribute("aria-pressed");
}

// What the host last rendered, read back by the assertions.
let seenWindow: ViewWindow = defaultWindow(5);
let seenLayout: LayoutSettings = defaultLayout;

function Host({ shown, locked = false, start = fitted }: { readonly shown: MarketState; readonly locked?: boolean; readonly start?: ViewWindow }) {
  const [layout, setLayout] = useState<LayoutSettings>({ ...defaultLayout, centerPrice: locked });
  const [view, setView] = useState<ViewWindow>(start);
  useEffect(() => {
    seenWindow = view;
    seenLayout = layout;
  });
  return (
    <MarketView
      market={shown}
      layout={layout}
      viewWindow={view}
      crosshair={sharedCrosshair}
      onWindow={(change) => setView((current) => change(current))}
      onResetWindow={() => setView(defaultWindow(shown.historyMinutes))}
      onTogglePane={() => undefined}
      onToggleKind={() => undefined}
      onReading={(change) => setLayout((current) => change(current))}
    />
  );
}

let sharedCrosshair = createCrosshairStore();

/** A new crosshair for this test; every Host it renders shares it. */
function freshCrosshair(): CrosshairStore {
  sharedCrosshair = createCrosshairStore();
  return sharedCrosshair;
}

/** A print a quarter of the plot below the middle of the fitted view, so centring it has to move the price. */
function lowerPrint(crosshair: CrosshairStore): number {
  const view = render(<Host shown={base} />);
  const price = Math.round(priceAt(crosshair, plotMidY * 1.5));
  view.unmount();
  return price;
}

describe("MarketView price controls", () => {
  it("should show +, −, Fit, Center and Lock beside the price chart with the Order Flow names and tooltip", () => {
    render(<Host shown={withPrint(100)} />);
    const group = screen.getByRole("group", { name: "Price" });

    expect(screen.getByRole("button", { name: "Zoom price in" }).textContent).toBe("+");
    expect(screen.getByRole("button", { name: "Zoom price out" }).textContent).toBe("−");
    expect(screen.getByRole("button", { name: "Fit" }).textContent).toBe("Fit");
    expect(screen.getByRole("button", { name: "Center price" }).textContent).toBe("Center");
    expect(screen.getByRole("button", { name: "Lock center" }).textContent).toBe("Lock");
    expect(screen.getByRole("button", { name: "Lock center" }).getAttribute("title")).toBe(lockTitle);
    expect(group.querySelectorAll("button")).toHaveLength(5);
    expect(group.closest(".chart-column")).not.toBeNull();
  });

  it("should zoom price about the middle on + and − and leave time alone", async () => {
    const user = userEvent.setup();
    const crosshair = freshCrosshair();
    render(<Host shown={withPrint(100)} />);
    const middle = priceAt(crosshair, plotMidY);

    await user.click(screen.getByRole("button", { name: "Zoom price in" }));
    expect(seenWindow.priceZoom).toBeCloseTo(chartZoomIn);
    expect(seenWindow.spanMs).toBe(fitted.spanMs);
    expect(priceAt(crosshair, plotMidY)).toBeCloseTo(middle, 4);

    await user.click(screen.getByRole("button", { name: "Zoom price out" }));
    expect(seenWindow.priceZoom).toBeCloseTo(chartZoomIn * chartZoomOut);
  });

  it("should put the last price in the middle when Center is pressed and keep the zoom", async () => {
    const user = userEvent.setup();
    const crosshair = freshCrosshair();
    const last = lowerPrint(crosshair);
    render(<Host shown={withPrint(last)} start={{ ...fitted, priceZoom: 0.5 }} />);
    expect(priceAt(crosshair, plotMidY)).not.toBeCloseTo(last, 0);

    await user.click(screen.getByRole("button", { name: "Center price" }));

    expect(priceAt(crosshair, plotMidY)).toBeCloseTo(last, 0);
    expect(seenWindow.priceZoom).toBe(0.5);
  });

  it("should disable Center before the first trade", () => {
    render(<Host shown={{ ...base, prints: [], bars: [], minuteBars: [], developingBar: null, developingMinute: null }} />);

    expect(screen.getByRole("button", { name: "Center price" })).toHaveProperty("disabled", true);
  });

  it("should save Lock on the layout and centre the last price when Lock is pressed", async () => {
    const user = userEvent.setup();
    const crosshair = freshCrosshair();
    const last = lowerPrint(crosshair);
    render(<Host shown={withPrint(last)} />);
    expect(lock()).toBe("false");

    await user.click(screen.getByRole("button", { name: "Lock center" }));

    expect(lock()).toBe("true");
    expect(seenLayout.centerPrice).toBe(true);
    expect(priceAt(crosshair, plotMidY)).toBeCloseTo(last, 0);

    await user.click(screen.getByRole("button", { name: "Lock center" }));
    expect(lock()).toBe("false");
    expect(seenLayout.centerPrice).toBe(false);
  });

  it("should keep the last price in the middle as the price moves while Lock is on", () => {
    const crosshair = freshCrosshair();
    const last = lowerPrint(crosshair);
    vi.useFakeTimers();
    const view = render(<Host shown={withPrint(last)} locked />);
    act(() => {
      vi.advanceTimersByTime(CENTER_FOLLOW_MS * 12);
    });
    expect(priceAt(crosshair, plotMidY)).toBeCloseTo(last, 0);

    view.rerender(<Host shown={withPrint(last + 6)} locked />);
    act(() => {
      vi.advanceTimersByTime(CENTER_FOLLOW_MS * 12);
    });

    expect(priceAt(crosshair, plotMidY)).toBeCloseTo(last + 6, 0);
    expect(lock()).toBe("true");
  });

  it("should keep the lock at 3 px and release it at 4 px without a price jump, and not re-centre on the next price", () => {
    expect(LOCK_RELEASE_DRAG_PX).toBe(4);
    const crosshair = freshCrosshair();
    const last = lowerPrint(crosshair);
    vi.useFakeTimers();
    const view = render(<Host shown={withPrint(last)} locked />);
    act(() => {
      vi.advanceTimersByTime(CENTER_FOLLOW_MS * 12);
    });
    const canvas = overlay();
    const y = 200;
    fireEvent(canvas, pointer("pointerdown", plotX, y));
    fireEvent(canvas, pointer("pointermove", plotX, y + 3));
    const held = priceAt(crosshair, plotMidY);
    expect(lock()).toBe("true");

    fireEvent(canvas, pointer("pointermove", plotX, y + LOCK_RELEASE_DRAG_PX));
    expect(lock()).toBe("false");
    expect(priceAt(crosshair, plotMidY)).toBeCloseTo(held, 6);
    fireEvent(canvas, pointer("pointerup", plotX, y + LOCK_RELEASE_DRAG_PX));

    view.rerender(<Host shown={withPrint(last + 20)} locked />);
    act(() => {
      vi.advanceTimersByTime(CENTER_FOLLOW_MS * 12);
    });
    expect(priceAt(crosshair, plotMidY)).toBeCloseTo(held, 6);
  });

  it("should keep the lock and leave the locked price step alone on a sideways drag", () => {
    const crosshair = freshCrosshair();
    const last = lowerPrint(crosshair);
    vi.useFakeTimers();
    const view = render(<Host shown={withPrint(last)} locked start={{ ...fitted, spanMs: 120_000 }} />);
    act(() => {
      vi.advanceTimersByTime(CENTER_FOLLOW_MS * 12);
    });
    const centred = priceAt(crosshair, plotMidY);
    const canvas = overlay();
    fireEvent(canvas, pointer("pointerdown", plotX, 200));
    view.rerender(<Host shown={withPrint(last + 20)} locked start={{ ...fitted, spanMs: 120_000 }} />);
    act(() => {
      vi.advanceTimersByTime(CENTER_FOLLOW_MS);
    });
    const stepped = priceAt(crosshair, plotMidY);
    expect(stepped).not.toBeCloseTo(centred, 4);

    fireEvent(canvas, pointer("pointermove", plotX + 120, 200 + LOCK_RELEASE_DRAG_PX - 1));

    expect(priceAt(crosshair, plotMidY)).toBeCloseTo(stepped, 6);
    expect(seenWindow.offsetMs).toBeGreaterThan(0);
    expect(lock()).toBe("true");
  });

  it.each([
    ["Shift+wheel", () => fireEvent(overlay(), wheel(-40, true))],
    ["the + button", () => fireEvent.click(screen.getByRole("button", { name: "Zoom price in" }))],
    ["the − button", () => fireEvent.click(screen.getByRole("button", { name: "Zoom price out" }))],
    ["Fit", () => fireEvent.click(screen.getByRole("button", { name: "Fit" }))],
    ["a double-click", () => fireEvent.doubleClick(overlay())],
  ])("should turn Lock off when %s is used", (_name, act) => {
    render(<Host shown={withPrint(100)} locked />);
    expect(lock()).toBe("true");

    act();

    expect(lock()).toBe("false");
  });

  it("should turn Lock off when a price zoom key is pressed on the chart", async () => {
    const user = userEvent.setup();
    render(<Host shown={withPrint(100)} locked />);
    screen.getByRole("application").focus();

    await user.keyboard("{Shift>}{ArrowUp}{/Shift}");

    expect(lock()).toBe("false");
  });

  it("should keep Lock on when the wheel zooms time", () => {
    render(<Host shown={withPrint(100)} locked />);

    fireEvent(overlay(), wheel(-40, false));

    expect(seenWindow.spanMs).toBeLessThan(fitted.spanMs);
    expect(lock()).toBe("true");
  });

  it("should keep Lock on through one pixel of vertical pinch jitter and turn it off on a vertical pinch", () => {
    render(<Host shown={withPrint(100)} locked />);
    const canvas = overlay();
    const gap = PINCH_AXIS_MIN_PX + 40;
    fireEvent(canvas, pointer("pointerdown", 200, 150, 1, "touch"));
    fireEvent(canvas, pointer("pointerdown", 200 + gap, 150 + gap, 2, "touch"));

    fireEvent(canvas, pointer("pointermove", 200 + gap + 60, 150 + gap + 1, 2, "touch"));
    expect(lock()).toBe("true");
    expect(seenWindow.priceZoom).toBe(1);

    fireEvent(canvas, pointer("pointermove", 200 + gap + 60, 150 + gap + 40, 2, "touch"));
    expect(lock()).toBe("false");
    expect(seenWindow.priceZoom).not.toBe(1);
  });

  it("should restore the default window and the fitted price when Fit is pressed", async () => {
    const user = userEvent.setup();
    const crosshair = freshCrosshair();
    render(<Host shown={withPrint(100)} start={{ spanMs: 120_000, offsetMs: 30_000, priceZoom: 0.5 }} />);
    const canvas = overlay();
    fireEvent(canvas, pointer("pointerdown", plotX, 200));
    fireEvent(canvas, pointer("pointermove", plotX, 290));
    fireEvent(canvas, pointer("pointerup", plotX, 290));

    await user.click(screen.getByRole("button", { name: "Fit" }));

    expect(seenWindow).toEqual(fitted);
    const fittedMiddle = priceAt(crosshair, plotMidY);
    cleanup();
    render(<Host shown={withPrint(100)} />);
    expect(priceAt(crosshair, plotMidY)).toBeCloseTo(fittedMiddle, 6);
  });
});

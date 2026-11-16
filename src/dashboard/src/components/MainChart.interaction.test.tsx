// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { PINCH_AXIS_MIN_PX } from "../domain/bookmap.ts";
import type { Candle } from "../domain/candles.ts";
import { chartZoomIn, chartZoomOut, readoutRefreshMs } from "../domain/chartCursor.ts";
import { formatTicks } from "../domain/format.ts";
import { fromSnapshot } from "../domain/merge.ts";
import { createCrosshairStore } from "../hooks/crosshair.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { MainChart } from "./MainChart.tsx";
import type { MainChartModel } from "./drawMainChart.ts";

const market = fromSnapshot(snapshotFixture(), 5, 0);
const candles: Candle[] = [
  { t: 1_700_000_000_000, d: 60_000, o: 100, h: 110, l: 90, c: 104, v: 12, bv: 7, sv: 5, developing: false },
  { t: 1_700_000_060_000, d: 60_000, o: 104, h: 120, l: 100, c: 118, v: 20, bv: 11, sv: 9, developing: true },
];
const noop = () => undefined;

function chartModel(volume?: number): MainChartModel {
  const next = candles.map((candle, index) => (volume !== undefined && index === candles.length - 1 ? { ...candle, v: volume } : candle));
  return {
    market,
    candles: next,
    startMs: (next[0]?.t ?? 0) - 60_000,
    endMs: (next.at(-1)?.t ?? 0) + 120_000,
    lowTicks: 0,
    highTicks: 100_000,
    heatmap: true,
    heatColumns: market.heat,
    heatMode: "intensity",
    heatContrast: 1,
    heatScale: 1,
    levelTouches: market.levelTouches,
    profile: null,
    emaIds: [],
    vwap: false,
    overlay: false,
    signals: [],
    isKindOn: () => false,
  };
}

function liveText(): string {
  return document.querySelector("[aria-live='polite']")?.textContent ?? "";
}

function overlay(): HTMLCanvasElement {
  const canvas = document.querySelector(".pane-overlay-interactive");
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("the overlay canvas is missing");
  return canvas;
}

function pointer(type: string, x: number, y: number, pointerType = "mouse", pointerId = 1): PointerEvent {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId, button: 0, pointerType });
  Object.defineProperty(event, "offsetX", { value: x });
  Object.defineProperty(event, "offsetY", { value: y });
  return event;
}

function wheel(deltaY: number, shiftKey: boolean): WheelEvent {
  return wheelAt(0, 0, deltaY, shiftKey);
}

function wheelAt(x: number, y: number, deltaY: number, shiftKey: boolean): WheelEvent {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY, shiftKey, clientX: x, clientY: y });
  Object.defineProperty(event, "offsetX", { value: x });
  Object.defineProperty(event, "offsetY", { value: y });
  return event;
}

beforeAll(() => {
  globalThis.ResizeObserver = class {
    private readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      this.callback([{ target, contentRect: { width: 800, height: 400, x: 0, y: 0, top: 0, left: 0, bottom: 400, right: 800, toJSON() { return {}; } } } as ResizeObserverEntry], this);
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
  vi.useRealTimers();
});

describe("MainChart keyboard", () => {
  it("should announce the previous bar when ArrowLeft is pressed", async () => {
    const user = userEvent.setup();
    render(<MainChart model={chartModel()} spec={market.instrument} crosshair={createCrosshairStore()} summary="MES chart" onZoomTime={noop} onZoomPrice={noop} onPan={noop} onPanPrice={noop} onReset={noop} />);
    const chart = screen.getByRole("application");
    const previous = candles.at(-2);
    const latest = candles.at(-1);
    if (!previous || !latest) throw new Error("the fixture needs two candles");

    chart.focus();
    await user.keyboard("{ArrowLeft}");

    expect(liveText()).toContain("volume 12");
    expect(liveText()).toContain(formatTicks(previous.c, market.instrument));
    expect(liveText()).not.toContain("volume 20");
    expect(latest.c).not.toBe(previous.c);
  });

  it("should leave the live region unchanged until the refresh interval when the same bar's volume changes", () => {
    vi.useFakeTimers();
    const view = render(<MainChart model={chartModel(10)} spec={market.instrument} crosshair={createCrosshairStore()} summary="MES chart" onZoomTime={noop} onZoomPrice={noop} onPan={noop} onPanPrice={noop} onReset={noop} />);
    act(() => {
      screen.getByRole("application").focus();
    });
    const first = liveText();

    view.rerender(<MainChart model={chartModel(80)} spec={market.instrument} crosshair={createCrosshairStore()} summary="MES chart" onZoomTime={noop} onZoomPrice={noop} onPan={noop} onPanPrice={noop} onReset={noop} />);
    expect(liveText()).toBe(first);

    act(() => {
      vi.advanceTimersByTime(readoutRefreshMs);
    });
    view.rerender(<MainChart model={chartModel(90)} spec={market.instrument} crosshair={createCrosshairStore()} summary="MES chart" onZoomTime={noop} onZoomPrice={noop} onPan={noop} onPanPrice={noop} onReset={noop} />);

    expect(liveText()).toContain("volume 90");
    expect(liveText()).not.toBe(first);
  });

  it("should not announce a hovered cell and should clear that readout when the pointer leaves", () => {
    const crosshair = createCrosshairStore();
    render(<MainChart model={chartModel()} spec={market.instrument} crosshair={crosshair} summary="MES chart" onZoomTime={noop} onZoomPrice={noop} onPan={noop} onPanPrice={noop} onReset={noop} />);
    const canvas = overlay();

    fireEvent(canvas, pointer("pointermove", 200, 120));

    expect(liveText()).toBe("");
    expect(document.querySelector(".chart-readout")).not.toBeNull();
    expect(crosshair.get().timeMs).not.toBeNull();

    fireEvent(canvas, pointer("pointerleave", 0, 0));

    expect(liveText()).toBe("");
    expect(document.querySelector(".chart-readout")).toBeNull();
    expect(crosshair.get()).toEqual({ timeMs: null, priceTicks: null });
  });

  it("should keep a keyboard crosshair when the pointer leaves", async () => {
    const user = userEvent.setup();
    const crosshair = createCrosshairStore();
    render(<MainChart model={chartModel()} spec={market.instrument} crosshair={crosshair} summary="MES chart" onZoomTime={noop} onZoomPrice={noop} onPan={noop} onPanPrice={noop} onReset={noop} />);
    const chart = screen.getByRole("application");

    chart.focus();
    await user.keyboard("{ArrowLeft}");
    const placed = crosshair.get();
    expect(placed.timeMs).not.toBeNull();
    expect(liveText()).toContain("volume 12");

    const canvas = overlay();
    fireEvent(canvas, pointer("pointermove", 500, 100));
    expect(crosshair.get().timeMs).not.toBe(placed.timeMs);

    fireEvent(canvas, pointer("pointerleave", 0, 0));

    expect(crosshair.get()).toEqual(placed);
    expect(liveText()).toContain("volume 12");
    expect(document.querySelector(".chart-readout")?.textContent).toContain("volume 12");
  });

  it("should zoom time on the wheel and zoom price when shift is held", () => {
    const onZoomTime = vi.fn();
    const onZoomPrice = vi.fn();
    render(<MainChart model={chartModel()} spec={market.instrument} crosshair={createCrosshairStore()} summary="MES chart" onZoomTime={onZoomTime} onZoomPrice={onZoomPrice} onPan={noop} onPanPrice={noop} onReset={noop} />);
    const canvas = overlay();

    fireEvent(canvas, wheel(120, false));
    fireEvent(canvas, wheel(-40, false));
    fireEvent(canvas, wheel(80, true));

    expect(onZoomTime).toHaveBeenNthCalledWith(1, chartZoomOut, 0);
    expect(onZoomTime).toHaveBeenNthCalledWith(2, chartZoomIn, 0);
    expect(onZoomPrice).toHaveBeenCalledTimes(1);
    expect(onZoomPrice).toHaveBeenCalledWith(chartZoomOut);
    expect(onZoomTime).toHaveBeenCalledTimes(2);
  });

  it("should ignore the wheel when the pointer is on the price axis", () => {
    const onZoomTime = vi.fn();
    render(<MainChart model={chartModel()} spec={market.instrument} crosshair={createCrosshairStore()} summary="MES chart" onZoomTime={onZoomTime} onZoomPrice={noop} onPan={noop} onPanPrice={noop} onReset={noop} />);

    fireEvent(overlay(), wheelAt(780, 100, 120, false));

    expect(onZoomTime).not.toHaveBeenCalled();
  });

  it("should pan by the drag distance when the pointer drags across the plot", () => {
    const onPan = vi.fn();
    render(<MainChart model={chartModel()} spec={market.instrument} crosshair={createCrosshairStore()} summary="MES chart" onZoomTime={noop} onZoomPrice={noop} onPan={onPan} onPanPrice={noop} onReset={noop} />);
    const canvas = overlay();

    fireEvent(canvas, pointer("pointerdown", 120, 80));
    fireEvent(canvas, pointer("pointermove", 180, 80));
    fireEvent(canvas, pointer("pointerup", 180, 80));

    expect(onPan).toHaveBeenCalledTimes(1);
    const shorter = onPan.mock.calls[0]?.[0] as number;
    expect(shorter).toBeGreaterThan(0);

    onPan.mockClear();
    fireEvent(canvas, pointer("pointerdown", 120, 80));
    fireEvent(canvas, pointer("pointermove", 280, 80));
    fireEvent(canvas, pointer("pointerup", 280, 80));

    expect(onPan).toHaveBeenCalledTimes(1);
    expect(onPan.mock.calls[0]?.[0] as number).toBeGreaterThan(shorter);
  });

  it("should pan price downward when the pointer drags down inside the plot", () => {
    const onPanPrice = vi.fn();
    render(<MainChart model={chartModel()} spec={market.instrument} crosshair={createCrosshairStore()} summary="MES chart" onZoomTime={noop} onZoomPrice={noop} onPan={noop} onPanPrice={onPanPrice} onReset={noop} />);
    const canvas = overlay();

    fireEvent(canvas, pointer("pointerdown", 200, 80));
    fireEvent(canvas, pointer("pointermove", 200, 160));
    fireEvent(canvas, pointer("pointerup", 200, 160));

    expect(onPanPrice).toHaveBeenCalled();
    expect(onPanPrice.mock.calls.reduce((sum, call) => sum + (call[0] as number), 0)).toBeGreaterThan(0);
  });

  it("should not pan when the drag starts on the price axis", () => {
    const onPan = vi.fn();
    const onPanPrice = vi.fn();
    render(<MainChart model={chartModel()} spec={market.instrument} crosshair={createCrosshairStore()} summary="MES chart" onZoomTime={noop} onZoomPrice={noop} onPan={onPan} onPanPrice={onPanPrice} onReset={noop} />);
    const canvas = overlay();

    fireEvent(canvas, pointer("pointerdown", 780, 80));
    fireEvent(canvas, pointer("pointermove", 700, 160));
    fireEvent(canvas, pointer("pointerup", 700, 160));

    expect(onPan).not.toHaveBeenCalled();
    expect(onPanPrice).not.toHaveBeenCalled();
  });

  it("should pan time when one finger drags across the plot", () => {
    const onPan = vi.fn();
    render(<MainChart model={chartModel()} spec={market.instrument} crosshair={createCrosshairStore()} summary="MES chart" onZoomTime={noop} onZoomPrice={noop} onPan={onPan} onPanPrice={noop} onReset={noop} />);
    const canvas = overlay();

    fireEvent(canvas, pointer("pointerdown", 120, 80, "touch"));
    fireEvent(canvas, pointer("pointermove", 200, 80, "touch"));
    fireEvent(canvas, pointer("pointerup", 200, 80, "touch"));

    expect(onPan).toHaveBeenCalled();
    expect(onPan.mock.calls[0]?.[0] as number).toBeGreaterThan(0);
  });

  it("should zoom time when a second finger spreads horizontally and not pan", () => {
    const onPan = vi.fn();
    const onZoomTime = vi.fn();
    const onZoomPrice = vi.fn();
    render(<MainChart model={chartModel()} spec={market.instrument} crosshair={createCrosshairStore()} summary="MES chart" onZoomTime={onZoomTime} onZoomPrice={onZoomPrice} onPan={onPan} onPanPrice={noop} onReset={noop} />);
    const canvas = overlay();

    fireEvent(canvas, pointer("pointerdown", 100, 100, "touch", 1));
    fireEvent(canvas, pointer("pointerdown", 100 + PINCH_AXIS_MIN_PX + 48, 110, "touch", 2));
    fireEvent(canvas, pointer("pointermove", 40, 100, "touch", 1));

    expect(onPan).not.toHaveBeenCalled();
    expect(onZoomPrice).not.toHaveBeenCalled();
    expect(onZoomTime).toHaveBeenCalled();
    expect(onZoomTime.mock.calls[0]?.[0] as number).toBeLessThan(1);
  });

  it("should zoom price when a second finger spreads vertically", () => {
    const onZoomTime = vi.fn();
    const onZoomPrice = vi.fn();
    render(<MainChart model={chartModel()} spec={market.instrument} crosshair={createCrosshairStore()} summary="MES chart" onZoomTime={onZoomTime} onZoomPrice={onZoomPrice} onPan={noop} onPanPrice={noop} onReset={noop} />);
    const canvas = overlay();

    fireEvent(canvas, pointer("pointerdown", 200, 40, "touch", 1));
    fireEvent(canvas, pointer("pointerdown", 220, 40 + PINCH_AXIS_MIN_PX + 80, "touch", 2));
    fireEvent(canvas, pointer("pointermove", 220, 40 + PINCH_AXIS_MIN_PX + 160, "touch", 2));

    expect(onZoomTime).not.toHaveBeenCalled();
    expect(onZoomPrice).toHaveBeenCalled();
    expect(onZoomPrice.mock.calls[0]?.[0] as number).toBeLessThan(1);
  });

  it("should not zoom a pinch axis whose fingers start within the minimum gap", () => {
    const onZoomTime = vi.fn();
    const onZoomPrice = vi.fn();
    const onPan = vi.fn();
    render(<MainChart model={chartModel()} spec={market.instrument} crosshair={createCrosshairStore()} summary="MES chart" onZoomTime={onZoomTime} onZoomPrice={onZoomPrice} onPan={onPan} onPanPrice={noop} onReset={noop} />);
    const canvas = overlay();

    fireEvent(canvas, pointer("pointerdown", 200, 100, "touch", 1));
    fireEvent(canvas, pointer("pointerdown", 200 + PINCH_AXIS_MIN_PX - 1, 100 + PINCH_AXIS_MIN_PX - 1, "touch", 2));
    fireEvent(canvas, pointer("pointermove", 40, 40, "touch", 1));

    expect(onPan).not.toHaveBeenCalled();
    expect(onZoomTime).not.toHaveBeenCalled();
    expect(onZoomPrice).not.toHaveBeenCalled();
  });

  it("should let the page scroll when time zoom reports that the window cannot move", () => {
    const stuck = wheel(120, false);
    const onZoomTime = vi.fn(() => false);
    render(<MainChart model={chartModel()} spec={market.instrument} crosshair={createCrosshairStore()} summary="MES chart" onZoomTime={onZoomTime} onZoomPrice={noop} onPan={noop} onPanPrice={noop} onReset={noop} />);

    fireEvent(overlay(), stuck);

    expect(onZoomTime).toHaveBeenCalled();
    expect(stuck.defaultPrevented).toBe(false);
  });

  it("should reset when the plot is double-clicked", () => {
    const onReset = vi.fn();
    render(<MainChart model={chartModel()} spec={market.instrument} crosshair={createCrosshairStore()} summary="MES chart" onZoomTime={noop} onZoomPrice={noop} onPan={noop} onPanPrice={noop} onReset={onReset} />);

    fireEvent.doubleClick(overlay());

    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("should clear the cursor and the live region when Escape is pressed", async () => {
    const user = userEvent.setup();
    render(<MainChart model={chartModel()} spec={market.instrument} crosshair={createCrosshairStore()} summary="MES chart" onZoomTime={noop} onZoomPrice={noop} onPan={noop} onPanPrice={noop} onReset={noop} />);
    const chart = screen.getByRole("application");

    chart.focus();
    await user.keyboard("{Escape}");

    expect(liveText()).toBe("");
    expect(document.activeElement).not.toBe(chart);
  });
});

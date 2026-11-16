// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { color } from "../design/tokens.ts";
import type { Candle } from "../domain/candles.ts";
import { defaultLayout } from "../domain/layout.ts";
import { fromSnapshot } from "../domain/merge.ts";
import { defaultWindow } from "../domain/viewWindow.ts";
import { createCrosshairStore } from "../hooks/crosshair.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { canvasTheme, colors } from "../theme.ts";
import { BookmapView } from "./BookmapView.tsx";
import { MainChart } from "./MainChart.tsx";
import type { MainChartModel } from "./drawMainChart.ts";
import { TimePane } from "./TimePane.tsx";

// Every pane redraws once, in the new theme's colours, when the theme changes.

/** Every full-canvas fill: the fill style each frame starts with, one entry per paint of a canvas. */
const grounds: string[] = [];

beforeAll(() => {
  globalThis.ResizeObserver = class {
    private readonly callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      this.callback(
        [{ target, contentRect: { width: 800, height: 400, x: 0, y: 0, top: 0, left: 0, bottom: 400, right: 800, toJSON() { return {}; } } } as ResizeObserverEntry],
        this,
      );
    }
    unobserve() {}
    disconnect() {}
  };
  HTMLCanvasElement.prototype.getContext = (() => {
    const state: Record<string | symbol, unknown> = { fillStyle: "#000", strokeStyle: "#000", font: "10px sans-serif" };
    return new Proxy(state, {
      get(target, key) {
        if (key in target) return target[key];
        if (key === "measureText") return () => ({ width: 12 });
        if (key === "createPattern") return () => null;
        return (...args: unknown[]) => {
          if (key === "fillRect" && args[0] === 0 && args[1] === 0 && args[2] === 800 && args[3] === 400) grounds.push(String(target.fillStyle));
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
  cleanup();
  act(() => canvasTheme.set("dark"));
  grounds.length = 0;
});

const market = fromSnapshot(snapshotFixture(), 5, 0);
const noop = () => undefined;

function chartModel(): MainChartModel {
  const candles: Candle[] = [{ t: 1_700_000_000_000, d: 60_000, o: 100, h: 110, l: 90, c: 104, v: 12, bv: 7, sv: 5, developing: false }];
  return {
    market,
    candles,
    startMs: 1_700_000_000_000 - 60_000,
    endMs: 1_700_000_000_000 + 120_000,
    lowTicks: 0,
    highTicks: 100_000,
    heatmap: false,
    heatColumns: [],
    heatMode: "intensity",
    heatContrast: 1,
    heatScale: 1,
    levelTouches: [],
    profile: null,
    emaIds: [],
    vwap: false,
    overlay: false,
    signals: [],
    isKindOn: () => false,
  };
}

describe("canvas redraw on a theme change", () => {
  it("should repaint a time-aligned pane once with the Light ground when the theme switches to Light", () => {
    const draw = vi.fn(({ ctx, width, height }: { ctx: CanvasRenderingContext2D; width: number; height: number }) => {
      ctx.fillStyle = colors.background;
      ctx.fillRect(0, 0, width, height);
      return { plotWidth: width, time: { toPx: () => 0, fromPx: () => 0 } } as never;
    });
    render(<TimePane label="CVD" summary="CVD pane" crosshair={createCrosshairStore()} draw={draw} />);
    const before = draw.mock.calls.length;

    act(() => canvasTheme.set("light"));

    expect(draw.mock.calls.length - before).toBe(1);
    expect(grounds.at(-1)).toBe(color("surface", "light"));
  });

  it("should repaint the main chart once with the Light ground when the theme switches to Light", () => {
    render(<MainChart model={chartModel()} spec={market.instrument} crosshair={createCrosshairStore()} summary="MES chart" onZoomTime={noop} onZoomPrice={noop} onPan={noop} onPanPrice={noop} onReset={noop} />);
    const before = grounds.length;

    act(() => canvasTheme.set("light"));

    expect(grounds.slice(before)).toEqual([color("surface", "light")]);
  });

  it("should repaint the Order Flow stage once in warm paper when the theme switches to Light", () => {
    render(<BookmapView market={market} layout={defaultLayout} viewWindow={defaultWindow(5)} onWindow={noop} onReading={noop} />);
    const before = grounds.length;

    act(() => canvasTheme.set("light"));

    expect(grounds.slice(before)).toEqual([color("surface-lowest", "light")]);
    expect(color("surface-lowest", "light")).toBe("#efede7");
  });
});

// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bookmapFrame, CENTER_FOLLOW_MS, LOCK_RELEASE_DRAG_PX } from "../domain/bookmap.ts";
import { chartZoomIn } from "../domain/chartCursor.ts";
import { defaultLayout, type LayoutSettings } from "../domain/layout.ts";
import { fromSnapshot, type MarketState } from "../domain/merge.ts";
import { defaultWindow, LIVE_EDGE_PAD, MIN_SPAN_MS, zoomTimeAbout, type ViewWindow } from "../domain/viewWindow.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { BookmapView } from "./BookmapView.tsx";

// A real plot size, so the hover readout and the drag have pixels to work with.
vi.mock("../hooks/useElementSize.ts", () => ({ useElementSize: () => ({ width: 800, height: 600 }) }));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

const market = fromSnapshot(snapshotFixture(), 5, 0);

afterEach(() => {
  cleanup();
});

function renderView(
  onWindow: (change: (current: ViewWindow) => ViewWindow) => void = () => undefined,
  shown: MarketState = market,
  viewWindow: ViewWindow = defaultWindow(5),
) {
  const view = render(
    <BookmapView market={shown} layout={defaultLayout} viewWindow={viewWindow} onWindow={onWindow} onReading={() => undefined} />,
  );
  return { ...view, stage: screen.getByTitle(/Shift\+wheel zooms price/) };
}

function priceAt(stage: HTMLElement, clientY: number): string {
  return cellAt(stage, "Price", 100, clientY);
}

function timeAt(stage: HTMLElement, clientX: number): string {
  return cellAt(stage, "Time", clientX, 180);
}

function cellAt(stage: HTMLElement, label: string, clientX: number, clientY: number): string {
  fireEvent.pointerMove(stage, { clientX, clientY, pointerId: 9 });
  const row = [...screen.getByLabelText("Order Flow readout").querySelectorAll("div")].find((item) => item.querySelector("dt")?.textContent === label);
  return row?.querySelector("dd")?.textContent ?? "";
}

function toNumber(text: string): number {
  return Number(text.replace(/,/g, ""));
}

function lastPrice(): number {
  const dt = [...screen.getByLabelText("Order Flow readout").querySelectorAll("dt")].find((item) => item.textContent === "Last");
  const match = dt?.parentElement?.querySelector("dd")?.textContent?.match(/-?[\d,]+\.\d+|-?[\d,]+/);
  return toNumber(match?.[0] ?? "");
}

function plotMidY(): number {
  return bookmapFrame(800, 600, { volume: true, cvd: true }).plot.h / 2;
}

function withPrint(priceTicks: number, base: MarketState = market): MarketState {
  return {
    ...base,
    prints: [{ sourceTimeMs: base.serverTimeMs - 1_000, priceTicks, quantity: 1, aggressor: "Bid", sequence: 1 }],
  };
}

const anchorTicks = Math.round(6890 / market.instrument.tickSize);

describe("BookmapView price zoom and vertical drag", () => {
  it("should zoom time on a plain wheel and price on Shift+wheel or the PRICE scale", () => {
    let window = defaultWindow(5);
    const { stage } = renderView((change) => {
      window = change(window);
    });

    const plain = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -40, clientX: 120, clientY: 200 });
    stage.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
    expect(window.spanMs).toBeLessThan(defaultWindow(5).spanMs);
    expect(window.priceZoom).toBe(1);
    const zoomedIn = window.spanMs;

    const timeAxis = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 40, clientX: 120, clientY: 500 });
    stage.dispatchEvent(timeAxis);
    expect(timeAxis.defaultPrevented).toBe(true);
    expect(window.spanMs).toBeGreaterThan(zoomedIn);

    const zoomIn = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -40, shiftKey: true, clientX: 120, clientY: 200 });
    stage.dispatchEvent(zoomIn);
    expect(zoomIn.defaultPrevented).toBe(true);
    expect(window.priceZoom).toBeCloseTo(chartZoomIn);
    stage.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 40, shiftKey: true, clientX: 120, clientY: 200 }));
    expect(window.priceZoom).toBeCloseTo(1);
  });

  it("should show higher prices after a downward drag and restore the fit on double-click", () => {
    const zooms: number[] = [];
    const { stage } = renderView((change) => zooms.push(change({ ...defaultWindow(5), priceZoom: 0.5 }).priceZoom));
    const before = priceAt(stage, 200);
    expect(before).not.toBe("—");

    fireEvent.pointerDown(stage, { button: 0, clientX: 100, clientY: 200, pointerId: 9 });
    fireEvent.pointerMove(stage, { clientX: 100, clientY: 320, pointerId: 9 });
    fireEvent.pointerUp(stage, { clientX: 100, clientY: 320, pointerId: 9 });
    const dragged = priceAt(stage, 200);
    expect(toNumber(dragged)).toBeGreaterThan(toNumber(before));

    // After release, moving the pointer no longer pans.
    priceAt(stage, 500);
    expect(priceAt(stage, 200)).toBe(dragged);

    fireEvent.doubleClick(stage);
    expect(priceAt(stage, 200)).toBe(before);
    expect(zooms.at(-1)).toBe(1);
  });

  it("should clamp a zoom written past the limit so the next notch back moves the price", () => {
    let latest = { ...defaultWindow(5), priceZoom: 20 };
    function Host() {
      const [window, setWindow] = useState(latest);
      return (
        <BookmapView
          market={market}
          layout={defaultLayout}
          viewWindow={window}
          onWindow={(change) =>
            setWindow((current) => {
              latest = change(current);
              return latest;
            })
          }
          onReading={() => undefined}
        />
      );
    }
    render(<Host />);
    const stage = screen.getByTitle(/Shift\+wheel zooms price/);
    act(() => {
      for (let step = 0; step < 6; step++) {
        stage.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 40, shiftKey: true, clientX: 560, clientY: 200 }));
      }
    });
    expect(latest.priceZoom).toBe(20);
    act(() => {
      stage.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -40, shiftKey: true, clientX: 560, clientY: 200 }));
    });
    expect(latest.priceZoom).toBeCloseTo(20 * chartZoomIn);
  });

  it("should not pan when the pointer starts on the dock or the volume strip", () => {
    const { stage } = renderView();
    const before = priceAt(stage, 200);

    fireEvent.pointerDown(stage, { button: 0, clientX: 700, clientY: 200, pointerId: 3 });
    fireEvent.pointerMove(stage, { clientX: 700, clientY: 400, pointerId: 3 });
    fireEvent.pointerUp(stage, { clientX: 700, clientY: 400, pointerId: 3 });
    expect(priceAt(stage, 200)).toBe(before);

    fireEvent.pointerDown(stage, { button: 0, clientX: 100, clientY: 540, pointerId: 4 });
    fireEvent.pointerMove(stage, { clientX: 100, clientY: 200, pointerId: 4 });
    fireEvent.pointerUp(stage, { clientX: 100, clientY: 200, pointerId: 4 });
    expect(priceAt(stage, 200)).toBe(before);
  });

  it("should restore the fitted range after dragging A, switching to B, and switching back to A", () => {
    const other = { ...market, root: "CL" };
    const { stage, rerender } = renderView();
    const fitted = priceAt(stage, 200);

    fireEvent.pointerDown(stage, { button: 0, clientX: 100, clientY: 200, pointerId: 9 });
    fireEvent.pointerMove(stage, { clientX: 100, clientY: 360, pointerId: 9 });
    fireEvent.pointerUp(stage, { clientX: 100, clientY: 360, pointerId: 9 });
    expect(toNumber(priceAt(stage, 200))).toBeGreaterThan(toNumber(fitted));

    rerender(<BookmapView market={other} layout={defaultLayout} viewWindow={defaultWindow(5)} onWindow={() => undefined} onReading={() => undefined} />);
    rerender(<BookmapView market={market} layout={defaultLayout} viewWindow={defaultWindow(5)} onWindow={() => undefined} onReading={() => undefined} />);
    expect(priceAt(screen.getByTitle(/Shift\+wheel zooms price/), 200)).toBe(fitted);
  });

  it("should zoom from the PRICE axis without Shift, and fit should restore the scale", () => {
    let window = defaultWindow(5);
    const { stage } = renderView((change) => {
      window = change(window);
    });

    stage.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 560, clientY: 200, deltaY: -40 }));
    expect(window.priceZoom).toBeCloseTo(chartZoomIn);

    fireEvent.pointerDown(stage, { button: 0, clientX: 560, clientY: 200, pointerId: 7 });
    fireEvent.pointerMove(stage, { clientX: 560, clientY: 80, pointerId: 7 });
    fireEvent.pointerUp(stage, { clientX: 560, clientY: 80, pointerId: 7 });
    expect(window.priceZoom).toBeLessThan(chartZoomIn);

    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(window.priceZoom).toBe(1);
  });

  it("should keep the price under the pointer across two wheel notches", () => {
    function Host() {
      const [window, setWindow] = useState(defaultWindow(5));
      return <BookmapView market={market} layout={defaultLayout} viewWindow={window} onWindow={setWindow} onReading={() => undefined} />;
    }
    render(<Host />);
    const stage = screen.getByTitle(/Shift\+wheel zooms price/);
    const before = priceAt(stage, 60);
    // Both notches in one act, so a queued updater cannot see a shift the first notch has not committed.
    act(() => {
      stage.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 560, clientY: 60, deltaY: -40 }));
      stage.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 560, clientY: 60, deltaY: -40 }));
    });
    expect(priceAt(stage, 60)).toBe(before);
  });

  it("should keep the time under the pointer across two wheel notches", () => {
    const historyMs = 5 * 60_000;
    const start = defaultWindow(5);
    let spanMs = start.spanMs;
    function Host() {
      const [window, setWindow] = useState(start);
      return (
        <BookmapView
          market={market}
          layout={defaultLayout}
          viewWindow={window}
          onWindow={(change) => {
            setWindow((current) => {
              const next = change(current);
              spanMs = next.spanMs;
              return next;
            });
          }}
          onReading={() => undefined}
        />
      );
    }
    render(<Host />);
    const stage = screen.getByTitle(/Shift\+wheel zooms price/);
    const before = timeAt(stage, 160);
    act(() => {
      stage.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 160, clientY: 180, deltaY: -40 }));
      stage.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 160, clientY: 180, deltaY: -40 }));
    });
    const once = zoomTimeAbout(start.spanMs, start.offsetMs, 0.5, chartZoomIn, historyMs).spanMs;
    const twice = zoomTimeAbout(once, start.offsetMs, 0.5, chartZoomIn, historyMs).spanMs;
    expect(timeAt(stage, 160)).toBe(before);
    expect(spanMs).toBeCloseTo(twice);
    expect(spanMs).toBeLessThan(once);
  });

  it("should pan time and price together and return to live on Fit", () => {
    const start = { ...defaultWindow(5), spanMs: 60_000 };
    const offsets: number[] = [];
    const { stage } = renderView((change) => offsets.push(change(start).offsetMs), market, start);
    const before = priceAt(stage, 200);

    fireEvent.pointerDown(stage, { button: 0, clientX: 80, clientY: 160, pointerId: 4 });
    fireEvent.pointerMove(stage, { clientX: 200, clientY: 280, pointerId: 4 });
    fireEvent.pointerUp(stage, { clientX: 200, clientY: 280, pointerId: 4 });

    expect(offsets.at(-1)).toBeGreaterThan(0);
    expect(toNumber(priceAt(stage, 200))).toBeGreaterThan(toNumber(before));

    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(offsets.at(-1)).toBe(0);
  });

  it("should show an event tooltip on the dot and dismiss it when the pointer leaves", () => {
    const low = market.status.coveredLow ?? 0;
    const high = market.status.coveredHigh ?? low;
    const prices = [0.15, 0.35, 0.5, 0.65, 0.85].map((fraction) => Math.round(low + (high - low) * fraction));
    const withEvent = {
      ...market,
      orderFlow: {
        ...market.orderFlow,
        signals: prices.map((priceTicks, index) => ({
          id: 9_001 + index,
          kind: "Iceberg",
          bias: "Bullish" as const,
          timeMs: market.serverTimeMs - 30_000,
          priceTicks,
          priceHighTicks: priceTicks,
          strength: 0.8,
          label: "Iceberg (inferred)",
          detail: "Refilled twice at the offer.",
        })),
        icebergs: prices.map((priceTicks) => ({
          side: "Ask",
          priceTicks,
          traded: 40,
          displayed: 10,
          peakDisplayed: 12,
          refills: 2,
          averageRefill: 8,
          hiddenEstimate: 20,
          confidence: 0.7,
          firstSeenMs: market.serverTimeMs - 33_000,
          lastFillMs: market.serverTimeMs - 30_000,
          active: true,
        })),
      },
    };
    const { stage } = renderView(() => undefined, withEvent);
    // Aim at a dot instead of scanning the plot: price and time are linear in the pointer position, so two probes
    // of the hover readout give the price scale and the frame gives the time scale. About a dozen moves, not 2,500.
    const frame = bookmapFrame(800, 600, { volume: true, cvd: true });
    const view = defaultWindow(5);
    const endMs = market.serverTimeMs + view.spanMs * LIVE_EDGE_PAD - view.offsetMs;
    const x = frame.plot.x + ((market.serverTimeMs - 30_000 - (endMs - view.spanMs)) / view.spanMs) * frame.plot.w;
    const y0 = frame.plot.y + 20;
    const y1 = frame.plot.y + frame.plot.h - 20;
    const p0 = toNumber(priceAt(stage, y0));
    const p1 = toNumber(priceAt(stage, y1));
    const target = (prices[2] ?? 0) * market.instrument.tickSize;
    const y = y0 + ((target - p0) / (p1 - p0)) * (y1 - y0);
    let tip: HTMLElement | null = null;
    for (const dy of [0, -1, 1, -2, 2, -3, 3]) {
      if (tip) break;
      fireEvent.pointerMove(stage, { clientX: x, clientY: y + dy, pointerId: 3 });
      const found = screen.queryByRole("tooltip");
      if (found?.textContent?.includes("Iceberg")) tip = found;
    }
    expect(tip?.textContent).toContain("Iceberg");
    expect(tip?.textContent).toContain("Inferred");
    expect(tip?.textContent).toContain("Ask");
    expect(tip?.textContent).toContain("2 refills");
    expect(tip?.textContent).toContain("Refilled twice at the offer.");
    fireEvent.pointerLeave(stage);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("should let the page scroll when a time wheel cannot zoom any further", () => {
    const full = defaultWindow(5);
    let window = full;
    const { stage, rerender } = renderView((change) => {
      window = change(window);
    });
    const zoomOut = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 40, clientX: 120, clientY: 200 });
    stage.dispatchEvent(zoomOut);
    expect(zoomOut.defaultPrevented).toBe(false);
    expect(window.spanMs).toBe(full.spanMs);

    const tight = { ...full, spanMs: MIN_SPAN_MS };
    let zoomedIn = 0;
    rerender(
      <BookmapView
        market={market}
        layout={defaultLayout}
        viewWindow={tight}
        onWindow={() => {
          zoomedIn += 1;
        }}
        onReading={() => undefined}
      />,
    );
    const zoomIn = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -40, clientX: 120, clientY: 200 });
    // After the wheel pauses, so the page scroll above does not carry on into this notch (D-53).
    Object.defineProperty(zoomIn, "timeStamp", { value: zoomOut.timeStamp + 1_000 });
    screen.getByTitle(/Shift\+wheel zooms price/).dispatchEvent(zoomIn);
    expect(zoomIn.defaultPrevented).toBe(false);
    expect(zoomedIn).toBe(0);
  });

  it("should zoom price and not time when a vertical pinch drifts sideways", () => {
    let window = defaultWindow(5);
    const { stage } = renderView((change) => {
      window = change(window);
    });
    fireEvent.pointerDown(stage, { button: 0, pointerId: 1, clientX: 200, clientY: 80 });
    fireEvent.pointerDown(stage, { button: 0, pointerId: 2, clientX: 206, clientY: 200 });
    fireEvent.pointerMove(stage, { pointerId: 2, clientX: 40, clientY: 90 });
    expect(window.spanMs).toBe(defaultWindow(5).spanMs);
    expect(window.priceZoom).not.toBe(1);
  });

  it("should zoom time and not price when a horizontal pinch drifts vertically", () => {
    let window = defaultWindow(5);
    const { stage } = renderView((change) => {
      window = change(window);
    });
    fireEvent.pointerDown(stage, { button: 0, pointerId: 1, clientX: 80, clientY: 180 });
    fireEvent.pointerDown(stage, { button: 0, pointerId: 2, clientX: 240, clientY: 184 });
    fireEvent.pointerMove(stage, { pointerId: 2, clientX: 400, clientY: 210 });
    expect(window.spanMs).toBeLessThan(defaultWindow(5).spanMs);
    expect(window.priceZoom).toBe(1);
  });

  it("should park the event key on the plot, clear of the dock, with a capped swatch", () => {
    render(
      <BookmapView
        market={market}
        layout={{ ...defaultLayout, eventDotSize: "large" }}
        viewWindow={defaultWindow(5)}
        onWindow={() => undefined}
        onReading={() => undefined}
      />,
    );
    const key = screen.getByLabelText("Event key");
    const frame = bookmapFrame(800, 600, { volume: true, cvd: true });
    expect(key.style.right).toBe(`${800 - frame.plot.w + 8}px`);
    expect(800 - frame.plot.w).toBe(268);
    expect(key.style.pointerEvents).toBe("none");
    expect(key.querySelector(".swatch")?.getAttribute("style") ?? "").not.toMatch(/width/);
  });

  it("should center the last price and keep the current zoom", () => {
    let window = { ...defaultWindow(5), priceZoom: 0.5 };
    const { stage } = renderView((change) => {
      window = change(window);
    }, withPrint(anchorTicks), window);
    fireEvent.pointerDown(stage, { button: 0, clientX: 100, clientY: 160, pointerId: 4 });
    fireEvent.pointerMove(stage, { clientX: 100, clientY: 280, pointerId: 4 });
    fireEvent.pointerUp(stage, { clientX: 100, clientY: 280, pointerId: 4 });
    const mid = plotMidY();
    expect(toNumber(priceAt(stage, mid))).not.toBeCloseTo(lastPrice(), 0);

    fireEvent.click(screen.getByRole("button", { name: "Center price" }));

    expect(toNumber(priceAt(stage, mid))).toBeCloseTo(lastPrice(), 1);
    expect(window.priceZoom).toBe(0.5);
  });

  it("should keep the last price centered while the lock is on, and release it on a vertical drag", () => {
    vi.useFakeTimers();
    try {
      function Host({ shown }: { readonly shown: MarketState }) {
        const [reading, setReading] = useState<LayoutSettings>({ ...defaultLayout, centerPrice: true });
        return (
          <BookmapView
            market={shown}
            layout={reading}
            viewWindow={defaultWindow(5)}
            onWindow={() => undefined}
            onReading={(change) => setReading((value) => change(value))}
          />
        );
      }
      const view = render(<Host shown={withPrint(anchorTicks)} />);
      const stage = screen.getByTitle(/Shift\+wheel zooms price/);
      const mid = plotMidY();
      act(() => {
        vi.advanceTimersByTime(CENTER_FOLLOW_MS * 12);
      });
      expect(toNumber(priceAt(stage, mid))).toBeCloseTo(lastPrice(), 1);

      view.rerender(<Host shown={withPrint(anchorTicks + 40)} />);
      act(() => {
        vi.advanceTimersByTime(CENTER_FOLLOW_MS * 12);
      });
      expect(toNumber(priceAt(stage, mid))).toBeCloseTo(lastPrice(), 1);
      expect(screen.getByRole("button", { name: "Lock center" }).getAttribute("aria-pressed")).toBe("true");

      fireEvent.pointerDown(stage, { button: 0, clientX: 120, clientY: 160, pointerId: 8 });
      fireEvent.pointerMove(stage, { clientX: 200, clientY: 160, pointerId: 8 });
      expect(screen.getByRole("button", { name: "Lock center" }).getAttribute("aria-pressed")).toBe("true");
      fireEvent.pointerMove(stage, { clientX: 200, clientY: 240, pointerId: 8 });
      expect(screen.getByRole("button", { name: "Lock center" }).getAttribute("aria-pressed")).toBe("false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("should keep the lock at 3 px and release it at 4 px without a price jump", () => {
    expect(LOCK_RELEASE_DRAG_PX).toBe(4);
    vi.useFakeTimers();
    try {
      function Host() {
        const [reading, setReading] = useState<LayoutSettings>({ ...defaultLayout, centerPrice: true });
        return (
          <BookmapView
            market={withPrint(anchorTicks)}
            layout={reading}
            viewWindow={defaultWindow(5)}
            onWindow={() => undefined}
            onReading={(change) => setReading((value) => change(value))}
          />
        );
      }
      render(<Host />);
      const stage = screen.getByTitle(/Shift\+wheel zooms price/);
      const mid = plotMidY();
      const lock = () => screen.getByRole("button", { name: "Lock center" }).getAttribute("aria-pressed");
      act(() => {
        vi.advanceTimersByTime(CENTER_FOLLOW_MS * 12);
      });
      const y = 180;
      fireEvent.pointerDown(stage, { button: 0, clientX: 120, clientY: y, pointerId: 8 });
      fireEvent.pointerMove(stage, { clientX: 120, clientY: y + 3, pointerId: 8 });
      const held = priceAt(stage, mid);
      expect(lock()).toBe("true");

      fireEvent.pointerMove(stage, { clientX: 120, clientY: y + LOCK_RELEASE_DRAG_PX, pointerId: 8 });
      expect(lock()).toBe("false");
      expect(priceAt(stage, mid)).toBe(held);
    } finally {
      vi.useRealTimers();
    }
  });

  it("should leave the locked price step in place when a sideways drag is down", () => {
    vi.useFakeTimers();
    try {
      function Host({ shown }: { readonly shown: MarketState }) {
        const [reading, setReading] = useState<LayoutSettings>({ ...defaultLayout, centerPrice: true });
        return (
          <BookmapView
            market={shown}
            layout={reading}
            viewWindow={defaultWindow(5)}
            onWindow={() => undefined}
            onReading={(change) => setReading((value) => change(value))}
          />
        );
      }
      const view = render(<Host shown={withPrint(anchorTicks)} />);
      const stage = screen.getByTitle(/Shift\+wheel zooms price/);
      const mid = plotMidY();
      act(() => {
        vi.advanceTimersByTime(CENTER_FOLLOW_MS * 12);
      });
      const centered = priceAt(stage, mid);
      fireEvent.pointerDown(stage, { button: 0, clientX: 120, clientY: 180, pointerId: 8 });
      view.rerender(<Host shown={withPrint(anchorTicks + 80)} />);
      act(() => {
        vi.advanceTimersByTime(CENTER_FOLLOW_MS);
      });
      const stepped = priceAt(stage, mid);
      expect(stepped).not.toBe(centered);
      fireEvent.pointerMove(stage, { clientX: 320, clientY: 180, pointerId: 8 });
      expect(priceAt(stage, mid)).toBe(stepped);
      expect(screen.getByRole("button", { name: "Lock center" }).getAttribute("aria-pressed")).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("should release the lock when a price zoom button is used", () => {
    function Host() {
      const [reading, setReading] = useState<LayoutSettings>({ ...defaultLayout, centerPrice: true });
      return (
        <BookmapView
          market={withPrint(anchorTicks)}
          layout={reading}
          viewWindow={defaultWindow(5)}
          onWindow={() => undefined}
          onReading={(change) => setReading((value) => change(value))}
        />
      );
    }
    render(<Host />);
    expect(screen.getByRole("button", { name: "Lock center" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Lock center" }).getAttribute("title")).toMatch(/price zoom/);
    fireEvent.click(screen.getByRole("button", { name: "Zoom price in" }));
    expect(screen.getByRole("button", { name: "Lock center" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("should keep the lock when a sideways pinch jitters by one pixel", () => {
    let priceZoom = 1;
    function Host() {
      const [reading, setReading] = useState<LayoutSettings>({ ...defaultLayout, centerPrice: true });
      const [window, setWindow] = useState(defaultWindow(5));
      priceZoom = window.priceZoom;
      return (
        <BookmapView
          market={market}
          layout={reading}
          viewWindow={window}
          onWindow={(change) => setWindow((current) => change(current))}
          onReading={(change) => setReading((value) => change(value))}
        />
      );
    }
    render(<Host />);
    const stage = screen.getByTitle(/Shift\+wheel zooms price/);
    const lock = () => screen.getByRole("button", { name: "Lock center" }).getAttribute("aria-pressed");
    fireEvent.pointerDown(stage, { button: 0, pointerId: 1, clientX: 80, clientY: 160 });
    fireEvent.pointerDown(stage, { button: 0, pointerId: 2, clientX: 240, clientY: 200 });
    fireEvent.pointerMove(stage, { pointerId: 2, clientX: 400, clientY: 201 });
    expect(lock()).toBe("true");
    expect(priceZoom).toBe(1);
    fireEvent.pointerMove(stage, { pointerId: 2, clientX: 420, clientY: 260 });
    expect(lock()).toBe("false");
    expect(priceZoom).not.toBe(1);
  });
});

describe("BookmapView wheel while the page scrolls", () => {
  // The stage's box on screen. jsdom lays nothing out, so the test places it.
  function placeStage(stage: HTMLElement, top: number): void {
    vi.spyOn(stage, "getBoundingClientRect").mockImplementation(
      () => ({ x: 0, y: top, left: 0, top, right: 800, bottom: top + 600, width: 800, height: 600, toJSON: () => ({}) }) as DOMRect,
    );
  }

  // Positions inside the stage: the plot, the PRICE column and the time strip.
  function wheelOn(stage: HTMLElement, x: number, y: number, timeStamp: number, shiftKey = false): WheelEvent {
    const top = stage.getBoundingClientRect().top;
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -40, shiftKey, clientX: x, clientY: top + y });
    Object.defineProperty(event, "timeStamp", { value: timeStamp });
    stage.dispatchEvent(event);
    return event;
  }

  it.each([
    ["a plain wheel on the plot", 120, 200, false],
    ["Shift+wheel on the plot", 120, 200, true],
    ["a wheel on the PRICE column", 560, 200, false],
    ["a wheel on the time strip", 120, 500, false],
  ])("should let the page scroll and leave the window alone when %s lands on a plot cut off by the bottom of the viewport", (_name, x, y, shiftKey) => {
    const onWindow = vi.fn();
    const { stage } = renderView(onWindow);
    placeStage(stage, window.innerHeight - 200);

    const event = wheelOn(stage, x, y, 1_000, shiftKey);

    expect(event.defaultPrevented).toBe(false);
    expect(onWindow).not.toHaveBeenCalled();
  });

  it("should say in the hint and the stage title that the wheel scrolls a page that can scroll while the plot is cut off", () => {
    sessionStorage.clear();
    const { stage } = renderView();
    const rule = /while the page can scroll and the plot is cut off, the wheel scrolls the page first/;

    expect(stage.title).toMatch(rule);
    expect(stage.querySelector(".bookmap-hint")?.textContent).toMatch(rule);
  });

  it("should zoom as before on a cut-off plot when the page cannot scroll", () => {
    // The wide layout: html, body and #root are overflow hidden, so letting the wheel through would do nothing.
    document.documentElement.style.overflow = "hidden";
    try {
      const onWindow = vi.fn();
      const { stage } = renderView(onWindow);
      placeStage(stage, window.innerHeight - 200);

      const event = wheelOn(stage, 120, 100, 1_000);

      expect(event.defaultPrevented).toBe(true);
      expect(onWindow).toHaveBeenCalledTimes(1);
    } finally {
      document.documentElement.style.overflow = "";
    }
  });

  it("should zoom time as before when the whole plot is in view", () => {
    const onWindow = vi.fn();
    const { stage } = renderView(onWindow);
    placeStage(stage, 50);

    const event = wheelOn(stage, 120, 200, 1_000);

    expect(event.defaultPrevented).toBe(true);
    expect(onWindow).toHaveBeenCalledTimes(1);
  });

  it("should zoom when the plot is in view even though the strips under it are cut off", () => {
    const onWindow = vi.fn();
    const { stage } = renderView(onWindow);
    const plot = bookmapFrame(800, 600, { volume: true, cvd: true }).plot;
    placeStage(stage, window.innerHeight - plot.y - plot.h - 10);

    const event = wheelOn(stage, 120, plot.y + plot.h / 2, 1_000);

    expect(event.defaultPrevented).toBe(true);
    expect(onWindow).toHaveBeenCalledTimes(1);
  });

  it("should keep scrolling the page through a gesture that began on a cut-off plot, and zoom once the wheel pauses", () => {
    const onWindow = vi.fn();
    const { stage } = renderView(onWindow);
    placeStage(stage, window.innerHeight - 200);
    wheelOn(stage, 120, 200, 1_000);

    // The page has scrolled the whole plot into view, and momentum is still arriving.
    placeStage(stage, 50);
    const momentum = [wheelOn(stage, 120, 200, 1_100), wheelOn(stage, 120, 200, 1_200)];

    expect(momentum.map((event) => event.defaultPrevented)).toEqual([false, false]);
    expect(onWindow).not.toHaveBeenCalled();

    const afterPause = wheelOn(stage, 120, 200, 1_500);

    expect(afterPause.defaultPrevented).toBe(true);
    expect(onWindow).toHaveBeenCalledTimes(1);
  });
});

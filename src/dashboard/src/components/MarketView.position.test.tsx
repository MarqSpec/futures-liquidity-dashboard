// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { defaultLayout, type DetailChartId, type LayoutSettings } from "../domain/layout.ts";
import { fromSnapshot } from "../domain/merge.ts";
import { positionSchema } from "../domain/position.ts";
import type { ViewWindow } from "../domain/viewWindow.ts";
import { createCrosshairStore } from "../hooks/crosshair.ts";
import { AXIS_WIDTH } from "../theme.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { BookmapView } from "./BookmapView.tsx";
import { MarketView } from "./MarketView.tsx";

// reference: REQUIREMENTS.md FR-72; ARCHITECTURE.md D-58

const market = fromSnapshot(snapshotFixture(), 5, 0);
const initial: ViewWindow = { spanMs: 180_000, offsetMs: 0, priceZoom: 1 };

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

function pointer(type: string, x: number, y: number, altKey = false): PointerEvent {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, button: 0, altKey });
  Object.defineProperty(event, "offsetX", { value: x });
  Object.defineProperty(event, "offsetY", { value: y });
  return event;
}

function renderDetail(chart: DetailChartId, start: LayoutSettings = defaultLayout) {
  const saved: { layout: LayoutSettings; windows: number } = { layout: { ...start, detailChart: chart }, windows: 0 };
  function Harness() {
    const [layout, setLayout] = useState(saved.layout);
    const [view, setView] = useState(initial);
    return (
      <MarketView
        market={market}
        layout={layout}
        viewWindow={view}
        crosshair={createCrosshairStore()}
        onWindow={(change) => {
          saved.windows += 1;
          setView((current) => change(current));
        }}
        onResetWindow={() => setView(initial)}
        onTogglePane={() => undefined}
        onToggleKind={() => undefined}
        onReading={(change) =>
          setLayout((current) => {
            saved.layout = change(current);
            return saved.layout;
          })
        }
      />
    );
  }
  render(<Harness />);
  return saved;
}

const position = positionSchema.parse({
  side: "long",
  entryType: "limit",
  entryTicks: market.liquidity.bestBid ?? 0,
  quantity: 1,
  stopTicks: (market.liquidity.bestBid ?? 0) - 4,
  targets: [{ priceTicks: (market.liquidity.bestBid ?? 0) + 8, quantity: 1 }],
  contractId: market.instrument.contractId,
  createdMs: 1,
});

describe.each(["price", "footprint"] as const)("MarketView simulated position on the %s chart", (chart) => {
  it("should place a limit entry and not pan when the plot is Alt-clicked", () => {
    const saved = renderDetail(chart);
    const x = (800 - AXIS_WIDTH) * 0.6;

    fireEvent(overlay(), pointer("pointerdown", x, 120, true));
    fireEvent(overlay(), pointer("pointermove", x + 60, 180));
    fireEvent(overlay(), pointer("pointerup", x + 60, 180));

    expect(saved.windows).toBe(0);
    const placed = saved.layout.positions[market.root];
    expect(placed?.entryType).toBe("limit");
    expect(placed?.contractId).toBe(market.instrument.contractId);
    expect(screen.getAllByText(/^SIMULATED .*entry/).length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: `Simulated position ${market.root}` }).textContent).toContain("SIMULATED");
  });

  it("should draw the saved position's lines and fill the ticket from it", () => {
    renderDetail(chart, { ...defaultLayout, positions: { [market.root]: position } });

    expect(screen.getByText("SIMULATED long entry ×1")).toBeTruthy();
    expect(screen.getByText("SIMULATED stop")).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Quantity").value).toBe("1");
  });
});

describe("a simulated position on both tabs", () => {
  it("should show the same position on Detail and on Order Flow when the layout holds one", () => {
    const layout = { ...defaultLayout, positions: { [market.root]: position } };
    const detail = render(
      <MarketView
        market={market}
        layout={layout}
        viewWindow={initial}
        crosshair={createCrosshairStore()}
        onWindow={() => undefined}
        onResetWindow={() => undefined}
        onTogglePane={() => undefined}
        onToggleKind={() => undefined}
        onReading={() => undefined}
      />,
    );
    const onDetail = screen.getByLabelText<HTMLInputElement>("Entry").value;
    detail.unmount();
    render(<BookmapView market={market} layout={layout} viewWindow={initial} onWindow={() => undefined} onReading={() => undefined} />);

    expect(screen.getByLabelText<HTMLInputElement>("Entry").value).toBe(onDetail);
    expect(onDetail).not.toBe("");
  });
});

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultLayout, type LayoutSettings } from "../domain/layout.ts";
import { fromSnapshot } from "../domain/merge.ts";
import { positionSchema } from "../domain/position.ts";
import { defaultWindow, type ViewWindow } from "../domain/viewWindow.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { BookmapView } from "./BookmapView.tsx";

// reference: REQUIREMENTS.md FR-72, FR-67; ARCHITECTURE.md D-58

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

function renderView(start: LayoutSettings = defaultLayout) {
  const onWindow = vi.fn<(change: (current: ViewWindow) => ViewWindow) => void>();
  const saved: { layout: LayoutSettings } = { layout: start };
  function Harness() {
    const [layout, setLayout] = useState(start);
    return (
      <BookmapView
        market={market}
        layout={layout}
        viewWindow={defaultWindow(5)}
        onWindow={onWindow}
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
  return { stage: screen.getByTitle(/Shift\+wheel zooms price/), onWindow, saved };
}

function readoutPrice(stage: HTMLElement, clientY: number): string {
  fireEvent.pointerMove(stage, { clientX: 100, clientY, pointerId: 9 });
  const row = [...screen.getByLabelText("Order Flow readout").querySelectorAll("div")].find((item) => item.querySelector("dt")?.textContent === "Price");
  return row?.querySelector("dd")?.textContent ?? "";
}

describe("BookmapView simulated position", () => {
  it("should place a limit entry at the clicked tick and not pan when the plot is Alt-clicked", () => {
    const { stage, onWindow, saved } = renderView();
    const clicked = readoutPrice(stage, 200);

    fireEvent.pointerDown(stage, { button: 0, altKey: true, clientX: 100, clientY: 200, pointerId: 9 });
    fireEvent.pointerMove(stage, { clientX: 180, clientY: 260, pointerId: 9 });
    fireEvent.pointerUp(stage, { clientX: 180, clientY: 260, pointerId: 9 });

    expect(onWindow).not.toHaveBeenCalled();
    const position = saved.layout.positions[market.root];
    expect(position?.entryType).toBe("limit");
    expect(position?.contractId).toBe(market.instrument.contractId);
    expect(screen.getByLabelText<HTMLInputElement>("Entry").value).toBe(clicked);
    expect(screen.getAllByText(/^SIMULATED .*entry/).length).toBeGreaterThan(0);
  });

  it("should still pan and place nothing when the plot is dragged without Alt", () => {
    const { stage, onWindow, saved } = renderView();

    fireEvent.pointerDown(stage, { button: 0, clientX: 100, clientY: 200, pointerId: 9 });
    fireEvent.pointerMove(stage, { clientX: 180, clientY: 200, pointerId: 9 });
    fireEvent.pointerUp(stage, { clientX: 180, clientY: 200, pointerId: 9 });

    expect(onWindow).toHaveBeenCalled();
    expect(saved.layout.positions).toEqual({});
  });

  it("should show the root's saved position and clear it from the ticket", () => {
    const position = positionSchema.parse({
      side: "short",
      entryType: "market",
      entryTicks: null,
      quantity: 1,
      stopTicks: Math.round(6900 / market.instrument.tickSize),
      targets: [],
      contractId: market.instrument.contractId,
      createdMs: 1,
    });
    const { saved } = renderView({ ...defaultLayout, positions: { [market.root]: position } });

    expect(screen.getByLabelText<HTMLInputElement>("Entry").value).toBe("Market");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(saved.layout.positions).toEqual({});
    expect(screen.getByRole("button", { name: "Place at last price" })).toBeTruthy();
  });
});

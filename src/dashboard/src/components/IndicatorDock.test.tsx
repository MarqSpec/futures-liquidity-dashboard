// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultLayout, type IndicatorPaneId, type LayoutSettings } from "../domain/layout.ts";
import { fromSnapshot } from "../domain/merge.ts";
import type { ViewWindow } from "../domain/viewWindow.ts";
import { createCrosshairStore } from "../hooks/crosshair.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { IndicatorDock } from "./IndicatorDock.tsx";
import { MarketView } from "./MarketView.tsx";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

const market = fromSnapshot(snapshotFixture(), 5, 0);

function WindowHarness() {
  const held = { spanMs: 180_000, offsetMs: 90_000, priceZoom: 1 } satisfies ViewWindow;
  const [layout, setLayout] = useState(defaultLayout);
  const [view, setView] = useState(held);
  const [crosshair] = useState(createCrosshairStore);
  return (
    <>
      <output data-testid="window">{`${view.offsetMs}:${view.spanMs}`}</output>
      <MarketView
        market={market}
        layout={layout}
        viewWindow={view}
        crosshair={crosshair}
        onWindow={(change) => setView((current) => change(current))}
        onResetWindow={() => setView({ ...held, offsetMs: 0 })}
        onTogglePane={() => undefined}
        onToggleKind={() => undefined}
        onReading={(change) => setLayout((current) => change(current))}
      />
    </>
  );
}

function DockHarness({ pane, collapsed = false }: { readonly pane?: IndicatorPaneId; readonly collapsed?: boolean }) {
  const [layout, setLayout] = useState<LayoutSettings>({
    ...defaultLayout,
    ...(pane ? { indicatorPane: pane } : {}),
    indicatorDockCollapsed: collapsed,
  });
  return (
    <>
      <output data-testid="saved">{`${layout.indicatorPane}:${layout.indicatorDockCollapsed ? "collapsed" : "expanded"}`}</output>
      <IndicatorDock
        market={market}
        layout={layout}
        indicators={market.indicators}
        startMs={market.serverTimeMs - 60_000}
        endMs={market.serverTimeMs}
        crosshair={createCrosshairStore()}
        showSinglePrints
        onReading={(change) => setLayout((current) => change(current))}
      />
    </>
  );
}

describe("IndicatorDock", () => {
  afterEach(() => {
    cleanup();
  });

  it("should show the footprint pane when the layout leaves the tab unset", () => {
    render(<DockHarness />);

    expect(screen.getByRole("tab", { name: "Footprint", selected: true })).toBeTruthy();
    expect(screen.getByRole("tabpanel").tabIndex).toBe(0);
    expect(screen.getByRole("region", { name: "Footprint" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "RSI 14" })).toBeNull();
    expect(screen.queryByRole("region", { name: "TPO profile" })).toBeNull();
  });

  it("should show only the selected pane when the layout names RSI", () => {
    render(<DockHarness pane="rsi14" />);

    expect(screen.getByRole("tab", { name: "RSI", selected: true })).toBeTruthy();
    expect(screen.getByRole("region", { name: "RSI 14" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Footprint" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Cumulative volume delta" })).toBeNull();
  });

  it("should keep the chosen tab when the viewer selects MACD", async () => {
    const user = userEvent.setup();
    render(<DockHarness />);

    await user.click(screen.getByRole("tab", { name: "MACD" }));

    expect(screen.getByRole("tab", { name: "MACD", selected: true })).toBeTruthy();
    expect(screen.getByRole("region", { name: "MACD 12/26/9" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Footprint" })).toBeNull();
  });

  it("should keep an off-live window when the indicator tab changes", async () => {
    const user = userEvent.setup();
    render(<WindowHarness />);

    expect(screen.getByTestId("window").textContent).toBe("90000:180000");

    await user.click(screen.getByRole("tab", { name: "ATR" }));

    expect(screen.getByRole("tab", { name: "ATR", selected: true })).toBeTruthy();
    expect(screen.getByTestId("window").textContent).toBe("90000:180000");
  });

  it("should show only the tab strip and save the choice when the viewer collapses the dock", async () => {
    const user = userEvent.setup();
    const { container } = render(<DockHarness pane="cvd" />);
    const toggle = screen.getByRole("button", { name: "Indicator dock" });

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("region", { name: "Cumulative volume delta" })).toBeTruthy();

    await user.click(toggle);

    expect(screen.getByRole("button", { name: "Indicator dock" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "Cumulative volume delta" })).toBeNull();
    expect(screen.queryByRole("tabpanel")).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(6);
    expect(container.querySelector(".indicator-dock.collapsed")).not.toBeNull();
    expect(screen.getByTestId("saved").textContent).toBe("cvd:collapsed");
  });

  it("should show the selected pane again when the viewer expands a collapsed dock", async () => {
    const user = userEvent.setup();
    const { container } = render(<DockHarness pane="rsi14" collapsed />);

    expect(screen.queryByRole("region", { name: "RSI 14" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Indicator dock" }));

    expect(screen.getByRole("button", { name: "Indicator dock" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("region", { name: "RSI 14" })).toBeTruthy();
    expect(container.querySelector(".indicator-dock.collapsed")).toBeNull();
    expect(screen.getByTestId("saved").textContent).toBe("rsi14:expanded");
  });

  it("should start collapsed with the saved tab selected when the layout collapses the dock", () => {
    const { container } = render(<DockHarness pane="macd" collapsed />);

    expect(screen.getByRole("button", { name: "Indicator dock" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("tab", { name: "MACD", selected: true })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "MACD 12/26/9" })).toBeNull();
    expect(container.querySelector(".indicator-dock.collapsed")).not.toBeNull();
  });

  it("should expand the dock on the chosen tab when the viewer picks a tab while it is collapsed", async () => {
    const user = userEvent.setup();
    render(<DockHarness collapsed />);

    await user.click(screen.getByRole("tab", { name: "ATR" }));

    expect(screen.getByRole("tab", { name: "ATR", selected: true })).toBeTruthy();
    expect(screen.getByRole("region", { name: "ATR 14" })).toBeTruthy();
    expect(screen.getByTestId("saved").textContent).toBe("atr14:expanded");
  });

  it("should move focus with Home, End and the arrows, including wraparound", async () => {
    const user = userEvent.setup();
    render(<DockHarness />);

    const tab = (name: string) => screen.getByRole("tab", { name, selected: true });
    screen.getByRole("tab", { name: "Footprint" }).focus();

    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(tab("CVD"));

    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(tab("Footprint"));

    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(tab("TPO"));
    expect(screen.queryByRole("region", { name: "Footprint" })).toBeNull();

    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(tab("Footprint"));

    await user.keyboard("{End}");
    expect(document.activeElement).toBe(tab("TPO"));

    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(tab("Footprint"));
    expect(screen.getByRole("region", { name: "Footprint" })).toBeTruthy();
  });
});

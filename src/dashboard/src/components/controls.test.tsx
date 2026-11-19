// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { defaultLayout } from "../domain/layout.ts";
import { instrumentsFixture } from "../test/fixtures.ts";
import { ChartToolbar } from "./ChartToolbar.tsx";
import { LayersPanel } from "./LayersPanel.tsx";
import { ProductPanel } from "./ProductPanel.tsx";
import { ProfilePanel } from "./ProfilePanel.tsx";

// The controls the design system restyles keep their accessible names, and each button group is a fieldset with a legend.

afterEach(cleanup);

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const noop = () => undefined;

function renderToolbar() {
  return render(
    <ChartToolbar
      historyMinutes={30}
      chartMinutes={1}
      indicatorMinutes={1}
      heatMode="intensity"
      heatContrast={1}
      layoutSource="server"
      following
      onHistory={noop}
      onChartMinutes={noop}
      onIndicatorMinutes={noop}
      onHeatMode={noop}
      onContrast={noop}
      onZoom={noop}
      onLive={noop}
    />,
  );
}

describe("ChartToolbar controls", () => {
  it.each(["Bars", "Window", "EMA timeframe", "Heatmap", "Zoom"])(
    "should group the %s buttons in a named fieldset when the toolbar renders",
    (name) => {
      renderToolbar();

      const group = screen.getByRole("group", { name });

      expect(group.tagName).toBe("FIELDSET");
      expect(group.className).toContain("segmented");
      expect(within(group).getAllByRole("button").length).toBeGreaterThan(0);
    },
  );

  it("should keep the zoom buttons findable by name when they join one group", () => {
    renderToolbar();

    const group = screen.getByRole("group", { name: "Zoom" });

    expect(within(group).getByRole("button", { name: "Zoom in" })).toBeTruthy();
    expect(within(group).getByRole("button", { name: "Zoom out" })).toBeTruthy();
  });

  it("should mark the chosen button of a group pressed when it is the current value", () => {
    renderToolbar();

    const group = screen.getByRole("group", { name: "Bars" });

    expect(within(group).getByRole("button", { name: "1m" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(group).getByRole("button", { name: "5m" }).getAttribute("aria-pressed")).toBe("false");
  });
});

describe("ProfilePanel controls", () => {
  it("should offer the profile windows as a named fieldset of toggle buttons when the panel renders", () => {
    render(
      <ProfilePanel
        profiles={[]}
        windows={["session", "1h"]}
        selected="1h"
        onSelect={noop}
        spec={instrumentsFixture()[0]!.instrument}
        lastTicks={null}
      />,
    );

    const group = screen.getByRole("group", { name: "Profile window" });

    expect(group.tagName).toBe("FIELDSET");
    expect(within(group).getByRole("button", { name: "1h" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(group).getByRole("button", { name: "session" }).getAttribute("aria-pressed")).toBe("false");
  });
});

describe("LayersPanel toggles", () => {
  it("should draw a swatch in the layer's own token beside the VWAP and the moving averages when the panel renders", () => {
    const { container } = render(
      <LayersPanel isPaneOn={() => true} onToggle={noop} indicators={[]} layout={defaultLayout} onReading={noop} />,
    );

    const swatches = [...container.querySelectorAll<HTMLElement>(".toggle-swatch")].map((node) => node.style.background);

    // — the range-zone box.
    expect(swatches).toEqual(["var(--vwap)", "var(--ema-10)", "var(--ema-13)", "var(--ema-24)", "var(--ema-48)", "var(--ema-200)", "var(--range-zone)"]);
  });

  it("should hide a swatch from assistive technology and keep the checkbox name when it has one", () => {
    const { container } = render(
      <LayersPanel isPaneOn={() => true} onToggle={noop} indicators={[]} layout={defaultLayout} onReading={noop} />,
    );

    expect(screen.getByRole("checkbox", { name: /^EMA 10/ })).toBeTruthy();
    expect(container.querySelector(".toggle-swatch")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("ProductPanel watchlist star", () => {
  beforeEach(() => globalThis.localStorage.setItem("futures-liquidity-dashboard.products-collapsed", "false"));

  const summaries = instrumentsFixture();
  const roots = summaries.map((s) => s.instrument.root);

  it("should be an icon button that keeps its name and pressed state when a product is watched", () => {
    render(<ProductPanel summaries={summaries} watchlist={[roots[0]!]} active={roots[0]!} refused={[]} onSelect={noop} onWatch={noop} />);

    const star = screen.getByRole("button", { name: `Remove ${roots[0]} from the watchlist` });

    expect([star.className.split(" ").includes("icon-button"), star.className.split(" ").includes("star"), star.getAttribute("aria-pressed")]).toEqual([
      true,
      true,
      "true",
    ]);
  });

  it("should be an unpressed icon button when a product is not watched", () => {
    render(<ProductPanel summaries={summaries} watchlist={[]} active={roots[0]!} refused={[]} onSelect={noop} onWatch={noop} />);

    const star = screen.getByRole("button", { name: `Add ${roots[0]} to the watchlist` });

    expect([star.classList.contains("icon-button"), star.getAttribute("aria-pressed")]).toEqual([true, "false"]);
  });
});

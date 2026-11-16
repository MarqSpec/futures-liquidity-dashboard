// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hints } from "../domain/hints.ts";
import { ChartToolbar, type ChartToolbarProps } from "./ChartToolbar.tsx";


afterEach(cleanup);

function renderToolbar(overrides: Partial<ChartToolbarProps> = {}) {
  const handlers = {
    onHistory: vi.fn(),
    onChartMinutes: vi.fn(),
    onIndicatorMinutes: vi.fn(),
    onHeatMode: vi.fn(),
    onContrast: vi.fn(),
    onZoom: vi.fn(),
    onLive: vi.fn(),
  };
  render(
    <ChartToolbar
      historyMinutes={30}
      chartMinutes={1}
      indicatorMinutes={1}
      heatMode="intensity"
      heatContrast={1}
      layoutSource="server"
      following
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

const labels = (group: HTMLElement) => within(group).getAllByRole("button").map((b) => b.textContent);

describe("ChartToolbar", () => {
  it("should hold Bars, Window, EMA timeframe and Heatmap as named groups in that order when it renders", () => {
    renderToolbar();

    const groups = within(screen.getByRole("toolbar", { name: "Chart controls" })).getAllByRole("group").map((g) => g.querySelector("legend")?.textContent);

    expect(groups).toEqual(["Bars", "Window", "EMA timeframe", "Heatmap", "Zoom"]);
  });

  it("should offer the choices of each group when it renders", () => {
    renderToolbar();

    expect([
      labels(screen.getByRole("group", { name: "Bars" })),
      labels(screen.getByRole("group", { name: "Window" })),
      labels(screen.getByRole("group", { name: "EMA timeframe" })),
      labels(screen.getByRole("group", { name: "Heatmap" })),
    ]).toEqual([
      ["1m", "2m", "5m", "15m"],
      ["30m", "1h", "4h", "1d", "3d"],
      ["1m", "5m", "15m"],
      ["Heat", "Added/pulled"],
    ]);
  });

  it("should mark the current value of each group pressed when it renders", () => {
    renderToolbar({ chartMinutes: 5, historyMinutes: 240, indicatorMinutes: 15, heatMode: "flow" });

    const pressed = (group: string) =>
      within(screen.getByRole("group", { name: group }))
        .getAllByRole("button", { pressed: true })
        .map((b) => b.textContent);

    expect([pressed("Bars"), pressed("Window"), pressed("EMA timeframe"), pressed("Heatmap")]).toEqual([["5m"], ["4h"], ["15m"], ["Added/pulled"]]);
  });

  it("should report the chosen value when a button of each group is pressed", () => {
    const h = renderToolbar();

    fireEvent.click(within(screen.getByRole("group", { name: "Bars" })).getByRole("button", { name: "15m" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Window" })).getByRole("button", { name: "1d" }));
    fireEvent.click(within(screen.getByRole("group", { name: "EMA timeframe" })).getByRole("button", { name: "5m" }));
    fireEvent.click(screen.getByRole("button", { name: "Added/pulled" }));

    expect([h.onChartMinutes.mock.calls, h.onHistory.mock.calls, h.onIndicatorMinutes.mock.calls, h.onHeatMode.mock.calls]).toEqual([
      [[15]],
      [[1440]],
      [[5]],
      [["flow"]],
    ]);
  });

  it("should find the contrast slider, both zoom buttons and Live by role and name when it renders", () => {
    const h = renderToolbar();

    fireEvent.change(screen.getByRole("slider", { name: "contrast" }), { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    fireEvent.click(screen.getByRole("button", { name: "Live" }));

    expect([h.onContrast.mock.calls, h.onZoom.mock.calls.map(([f]) => (f as number) < 1), h.onLive.mock.calls.length]).toEqual([[[2.5]], [true, false], 1]);
  });

  it("should draw Live filled and pressed while following when it renders", () => {
    renderToolbar();

    const live = screen.getByRole("button", { name: "Live" });

    expect([live.classList.contains("filled"), live.getAttribute("aria-pressed")]).toEqual([true, "true"]);
  });

  it("should say where the layout is saved when it renders", () => {
    renderToolbar({ layoutSource: "browser" });

    expect(screen.getByText("layout: this browser")).toBeTruthy();
  });

  it("should explain the heatmap contrast and Live and leave the interval, window and zoom buttons without a hint", () => {
    renderToolbar();
    const describedText = (control: HTMLElement) => document.getElementById(control.getAttribute("aria-describedby") ?? "")?.textContent;

    expect(describedText(screen.getByRole("slider", { name: "contrast" }))).toBe(hints.heatContrast);
    expect(describedText(screen.getByRole("button", { name: "Live" }))).toBe(hints.live);
    for (const control of [
      ...within(screen.getByRole("group", { name: "Bars" })).getAllByRole("button"),
      ...within(screen.getByRole("group", { name: "Window" })).getAllByRole("button"),
      screen.getByRole("button", { name: "Zoom in" }),
      screen.getByRole("button", { name: "Zoom out" }),
    ]) {
      expect(control.hasAttribute("aria-describedby")).toBe(false);
    }
  });

  it("should show the Live hint on keyboard focus", () => {
    renderToolbar();

    act(() => screen.getByRole("button", { name: "Live" }).focus());

    expect(screen.getByRole("tooltip").textContent).toBe(hints.live);
  });
});

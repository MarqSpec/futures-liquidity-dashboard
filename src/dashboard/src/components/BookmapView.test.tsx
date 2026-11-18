// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultLayout, toLayout, withRipsPreset } from "../domain/layout.ts";
import { hints } from "../domain/hints.ts";
import { fromSnapshot } from "../domain/merge.ts";
import { defaultWindow } from "../domain/viewWindow.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { BookmapView } from "./BookmapView.tsx";

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

describe("BookmapView", () => {
  it("should offer the prototype controls and the hover readout when the tab is shown", async () => {
    const user = userEvent.setup();
    render(<BookmapView market={market} layout={defaultLayout} viewWindow={defaultWindow(5)} onWindow={() => undefined} onReading={() => undefined} />);

    expect(screen.getByRole("button", { name: "Nodes (HVN/LVN)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Value area (POC/VAH/VAL)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Flow ±" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Display" }));
    expect(screen.getByRole("button", { name: "Candles Overlay" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "PNC & Trail Guide" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Event key" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Zoom price in" }).textContent).toBe("+");
    expect(screen.getByRole("button", { name: "Zoom price out" }).textContent).toBe("−");
    expect(screen.getByRole("button", { name: "Fit" })).toBeTruthy();
    expect(screen.getByLabelText("Event key")).toBeTruthy();
    expect(screen.getByText(/Drag the PRICE scale to zoom/)).toBeTruthy();
    expect(screen.getByLabelText("Order Flow readout").textContent).toContain("Hover the chart");
  });

  it("should paint each event key swatch from its kind's token variable so the key follows the theme when it renders", () => {
    render(<BookmapView market={market} layout={defaultLayout} viewWindow={defaultWindow(5)} onWindow={() => undefined} onReading={() => undefined} />);

    const swatches = [...screen.getByLabelText("Event key").querySelectorAll<HTMLElement>(".swatch")];

    // Iceberg is inferred, so hollow: only its ring takes the colour. Stacked imbalance is filled.
    expect(swatches.map((swatch) => swatch.style.borderColor).slice(0, 2)).toEqual(["var(--event-iceberg)", "var(--event-stacked-imbalance)"]);
    expect(swatches[1]?.style.background).toBe("var(--event-stacked-imbalance)");
    expect(swatches).toHaveLength(10);
  });

  it("should read the slice as VWAP, buy and sell and colour each value by its side when the readout renders", () => {
    render(<BookmapView market={market} layout={defaultLayout} viewWindow={defaultWindow(5)} onWindow={() => undefined} onReading={() => undefined} />);
    const readout = screen.getByLabelText("Order Flow readout");
    const value = (label: string) => [...readout.querySelectorAll("dt")].find((dt) => dt.textContent === label)?.nextElementSibling;

    expect([...readout.querySelectorAll("dt")].map((dt) => dt.textContent).slice(0, 7)).toEqual([
      "Time",
      "Price",
      "Slice VWAP",
      "Buy",
      "Sell",
      "Resting bid",
      "Resting ask",
    ]);
    expect(value("Buy")?.className).toBe("up");
    expect(value("Sell")?.className).toBe("down");
    expect(value("Resting bid")?.className).toBe("bid");
    expect(value("Resting ask")?.className).toBe("ask");
    expect(value("Slice VWAP")?.textContent).toBe("—");
  });

  it("should key the heat legend with the five stops, the cutoffs and the percentile pair when intensity heat is on", () => {
    const layout = { ...defaultLayout, heatMode: "intensity" as const, heatAutoContrast: true, heatLowPercentile: 5, heatHighPercentile: 98 };
    render(<BookmapView market={market} layout={layout} viewWindow={defaultWindow(5)} onWindow={() => undefined} onReading={() => undefined} />);
    const legend = screen.getByRole("figure", { name: /^Heat scale/ });

    expect(legend.querySelectorAll(".bookmap-heat-bar")).toHaveLength(1);
    expect(legend.textContent).toContain("p5–p98");
    expect(legend.getAttribute("aria-label")).toContain("5th to 98th percentile");
    expect(legend.querySelectorAll(".bookmap-heat-ticks span")).toHaveLength(2);
  });

  it("should mark the key as a log scale with no percentile pair when the fixed scale is on", () => {
    const layout = { ...defaultLayout, heatMode: "intensity" as const, heatAutoContrast: false };
    render(<BookmapView market={market} layout={layout} viewWindow={defaultWindow(5)} onWindow={() => undefined} onReading={() => undefined} />);
    const legend = screen.getByRole("figure", { name: /^Heat scale/ });

    expect(legend.textContent).toContain("log");
    expect(legend.textContent).not.toMatch(/p\d+–p\d+/);
    expect(legend.getAttribute("aria-label")).toContain("logarithmic");
  });

  it.each([
    { mode: "intensity" as const, contrast: 0.5, note: "contrast 0.5×" },
    { mode: "intensity" as const, contrast: 2, note: "contrast 2×" },
    { mode: "flow" as const, contrast: 0.3, note: "contrast 0.3×" },
  ])("should note $note beside the cutoffs when $mode heat has contrast $contrast", ({ mode, contrast, note }) => {
    const layout = { ...defaultLayout, heatMode: mode, heatContrast: contrast };
    render(<BookmapView market={market} layout={layout} viewWindow={defaultWindow(5)} onWindow={() => undefined} onReading={() => undefined} />);
    const legend = screen.getByRole("figure", { name: /^Heat scale/ });

    expect(legend.textContent).toContain(note);
    expect(legend.getAttribute("aria-label")).toContain(note);
  });

  it.each(["intensity" as const, "flow" as const])("should print no contrast note when %s heat has contrast 1", (mode) => {
    const layout = { ...defaultLayout, heatMode: mode, heatContrast: 1 };
    render(<BookmapView market={market} layout={layout} viewWindow={defaultWindow(5)} onWindow={() => undefined} onReading={() => undefined} />);

    expect(screen.getByRole("figure", { name: /^Heat scale/ }).textContent).not.toContain("contrast");
  });

  it("should key flow heat as added and pulled instead of the intensity ramp when flow heat is on", () => {
    const layout = { ...defaultLayout, heatMode: "flow" as const };
    render(<BookmapView market={market} layout={layout} viewWindow={defaultWindow(5)} onWindow={() => undefined} onReading={() => undefined} />);
    const legend = screen.getByRole("figure", { name: /^Heat scale/ });

    expect(legend.querySelector(".bookmap-heat-bar")).toBeNull();
    expect(legend.textContent).toContain("added");
    expect(legend.textContent).toContain("pulled");
    expect(legend.textContent).toContain("±");
  });

  it("should write the Nodes preset, flow heat, dimming and the dot filter through the layout", async () => {
    const user = userEvent.setup();
    const seen: { preset?: string; heatMode?: string; heatDim?: number; dotMinQuantity?: number; eventDotSize?: string; showCandles?: boolean; showPriceLine?: boolean }[] = [];
    render(
      <BookmapView
        market={market}
        layout={defaultLayout}
        viewWindow={defaultWindow(5)}
        onWindow={() => undefined}
        onReading={(change) => {
          const next = change(defaultLayout);
          seen.push({
            preset: next.preset,
            heatMode: next.heatMode,
            heatDim: next.heatDim,
            dotMinQuantity: next.dotMinQuantity,
            eventDotSize: next.eventDotSize,
            showCandles: next.showCandles,
            showPriceLine: next.showPriceLine,
          });
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Nodes (HVN/LVN)" }));
    await user.click(screen.getByRole("button", { name: "Flow ±" }));
    await user.click(screen.getByRole("button", { name: "Display" }));
    await user.click(screen.getByRole("button", { name: "50%" }));
    await user.click(screen.getByRole("button", { name: ">= 220" }));
    await user.click(screen.getByRole("button", { name: "Large" }));
    await user.click(screen.getByRole("button", { name: "Candles Overlay" }));
    await user.click(screen.getByRole("button", { name: "Price line" }));

    expect(seen.map((row) => row.preset)).toContain("rips");
    expect(seen.map((row) => row.heatMode)).toContain("flow");
    expect(seen.map((row) => row.heatDim)).toContain(0.5);
    expect(seen.map((row) => row.dotMinQuantity)).toContain(220);
    expect(seen.map((row) => row.eventDotSize)).toContain("large");
    expect(seen.at(-2)?.showCandles).toBe(true);
    expect(seen.at(-1)?.showPriceLine).toBe(false);
  });

  it("should return to the standard preset without recomputing the stored profile", async () => {
    const user = userEvent.setup();
    let preset = "";
    const rips = withRipsPreset(defaultLayout, true);
    render(
      <BookmapView
        market={market}
        layout={rips}
        viewWindow={defaultWindow(5)}
        onWindow={() => undefined}
        onReading={(change) => {
          preset = change(rips).preset;
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Value area (POC/VAH/VAL)" }));

    expect(preset).toBe("standard");
  });

  it("should press the Nodes preset when a layout saved before the rename names the stored rips value", () => {
    const saved = toLayout(JSON.parse(JSON.stringify(withRipsPreset(defaultLayout, true))));
    render(<BookmapView market={market} layout={saved} viewWindow={defaultWindow(5)} onWindow={() => undefined} onReading={() => undefined} />);

    expect(saved.preset).toBe("rips");
    expect(screen.getByRole("button", { name: "Nodes (HVN/LVN)" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Value area (POC/VAH/VAL)" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("should no longer name the presets RIPS or Standard when the controls render", () => {
    render(<BookmapView market={market} layout={defaultLayout} viewWindow={defaultWindow(5)} onWindow={() => undefined} onReading={() => undefined} />);

    expect(screen.queryByRole("button", { name: /RIPS|Standard/ })).toBeNull();
  });

  it("should explain each preset and heat mode on focus and describe the control by that text", () => {
    render(<BookmapView market={market} layout={defaultLayout} viewWindow={defaultWindow(5)} onWindow={() => undefined} onReading={() => undefined} />);
    const expected = [
      ["Nodes (HVN/LVN)", hints.presetNodes],
      ["Value area (POC/VAH/VAL)", hints.presetValueArea],
      ["Intensity", hints.heatIntensity],
      ["Flow ±", hints.heatFlow],
    ] as const;

    for (const [name, text] of expected) {
      const control = screen.getByRole("button", { name });
      expect(control.hasAttribute("title")).toBe(false);
      expect(control.getAttribute("aria-describedby")).toBeTruthy();
      act(() => control.focus());
      expect(screen.getByRole("tooltip").textContent).toBe(text);
      expect(document.getElementById(control.getAttribute("aria-describedby") ?? "")?.textContent).toBe(text);
      act(() => control.blur());
      expect(screen.queryByRole("tooltip")).toBeNull();
    }
  });

  it("should keep the preset and heat toggles out of the joined strips as direct children, so a touch toggle cannot split a group", () => {
    render(<BookmapView market={market} layout={defaultLayout} viewWindow={defaultWindow(5)} onWindow={() => undefined} onReading={() => undefined} />);

    for (const group of ["Preset", "Heat"]) {
      const direct = [...screen.getByRole("group", { name: group }).children].filter((child) => child.tagName === "BUTTON");

      expect(direct.map((child) => child.classList.contains("hint-toggle"))).toEqual([false, false]);
    }
  });

  it("should explain each Display menu item and leave the price and zoom buttons without a hint", async () => {
    const user = userEvent.setup();
    render(<BookmapView market={market} layout={defaultLayout} viewWindow={defaultWindow(5)} onWindow={() => undefined} onReading={() => undefined} />);
    await user.click(screen.getByRole("button", { name: "Display" }));
    const display = [
      [() => screen.getByRole("group", { name: "Dimming" }), hints.displayDimming],
      [() => screen.getByRole("group", { name: "Min dot" }), hints.displayMinDot],
      [() => screen.getByRole("group", { name: "Event dots" }), hints.displayEventDots],
      [() => screen.getByRole("button", { name: "Candles Overlay" }), hints.displayCandles],
      [() => screen.getByRole("button", { name: "Price line" }), hints.displayPriceLine],
      [() => screen.getByRole("button", { name: "BBO Lines" }), hints.displayBbo],
      [() => screen.getByRole("button", { name: "PNC & Trail Guide" }), hints.displayPnc],
      [() => screen.getByRole("button", { name: "Event key" }), hints.displayKey],
    ] as const;

    for (const [find, text] of display) {
      const control = find();
      expect(document.getElementById(control.getAttribute("aria-describedby") ?? "")?.textContent).toBe(text);
    }
    for (const name of ["Zoom price in", "Zoom price out", "Fit", "Center price"]) {
      expect(screen.getByRole("button", { name }).hasAttribute("aria-describedby")).toBe(false);
    }
  });

  it("should say depth is not subscribed when the server is not receiving the book", () => {
    const tradesOnly = { ...market, status: { ...market.status, depthSubscribed: false, bookKnown: false } };
    render(<BookmapView market={tradesOnly} layout={defaultLayout} viewWindow={defaultWindow(5)} onWindow={() => undefined} onReading={() => undefined} />);

    expect(screen.getByRole("note").textContent).toContain("depth not subscribed");
  });

  it("should say the book is recovering when depth is on and the book is unknown", () => {
    const recovering = {
      ...market,
      status: { ...market.status, depthSubscribed: true, bookKnown: false },
      liquidity: { ...market.liquidity, bookKnown: false },
    };
    render(<BookmapView market={recovering} layout={defaultLayout} viewWindow={defaultWindow(5)} onWindow={() => undefined} onReading={() => undefined} />);

    expect(screen.getByRole("note").textContent).toContain("book recovering");
  });

  it("should turn the trail guide off when its toggle is cleared", async () => {
    const user = userEvent.setup();
    render(<BookmapView market={market} layout={defaultLayout} viewWindow={defaultWindow(5)} onWindow={() => undefined} onReading={() => undefined} />);
    await user.click(screen.getByRole("button", { name: "Display" }));
    const guide = screen.getByRole("button", { name: "PNC & Trail Guide" });

    expect(guide.getAttribute("aria-pressed")).toBe("true");
    await user.click(guide);
    expect(guide.getAttribute("aria-pressed")).toBe("false");
  });
});

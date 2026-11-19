// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultLayout, isPaneOn, withPane, type LayoutSettings } from "../domain/layout.ts";
import { RangeZoneControls } from "./RangeZoneControls.tsx";

// reference: REQUIREMENTS.md FR-75, FR-9

/** The layout the last onReading call would save, from `from`. */
function applied(onReading: ReturnType<typeof vi.fn>, from: LayoutSettings = defaultLayout): LayoutSettings {
  const change = onReading.mock.calls.at(-1)?.[0] as ((current: LayoutSettings) => LayoutSettings) | undefined;
  if (!change) throw new Error("onReading was not called");
  return change(from);
}

afterEach(cleanup);

describe("RangeZoneControls", () => {
  it("should show the Range zones toggle on and five-minute bars when the layout is the default", () => {
    render(<RangeZoneControls layout={defaultLayout} onReading={vi.fn()} variant="layers" />);

    expect((screen.getByRole("checkbox", { name: "Range zones" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("combobox", { name: "Range zone bars" }) as HTMLSelectElement).value).toBe("300");
  });

  it("should turn the Range zones layer off when the toggle is unchecked", async () => {
    const onReading = vi.fn();
    render(<RangeZoneControls layout={defaultLayout} onReading={onReading} variant="layers" />);

    await userEvent.click(screen.getByRole("checkbox", { name: "Range zones" }));

    expect(isPaneOn(applied(onReading), "range-zones")).toBe(false);
  });

  it("should save the chosen bars when the timeframe is changed", async () => {
    const onReading = vi.fn();
    render(<RangeZoneControls layout={defaultLayout} onReading={onReading} variant="layers" />);

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Range zone bars" }), "15m");
    expect(applied(onReading).rangeZoneTimeframe).toBe("900");

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Range zone bars" }), "Off");
    expect(applied(onReading).rangeZoneTimeframe).toBe("off");
  });

  it("should offer the same toggle and bars as pressed buttons on Order Flow", async () => {
    const onReading = vi.fn();
    const off = withPane(defaultLayout, "range-zones", false);
    render(<RangeZoneControls layout={off} onReading={onReading} variant="display" />);

    const toggle = screen.getByRole("button", { name: "Range zones" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "5m" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "15m" }).getAttribute("aria-pressed")).toBe("false");

    await userEvent.click(toggle);
    expect(isPaneOn(applied(onReading, off), "range-zones")).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "15m" }));
    expect(applied(onReading, off).rangeZoneTimeframe).toBe("900");
  });
});

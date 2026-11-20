// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Condition } from "../domain/conditions.ts";
import { ConditionsPanel } from "./ConditionsPanel.tsx";


afterEach(() => {
  cleanup();
});

const ready: Condition = {
  id: "price-vwap",
  name: "Price vs VWAP",
  definition: "The current book against the session VWAP: above when the best bid is over it.",
  value: "bid 5002.00 / ask 5002.25 · VWAP 5000.13",
  reading: { kind: "state", state: "above" },
};

const warming: Condition = {
  id: "ema-13-48",
  name: "EMA 13 vs EMA 48",
  definition: "On closed 1-minute bars: above when EMA 13 is over EMA 48.",
  value: "EMA 13 — · EMA 48 —",
  reading: { kind: "warming", seen: 20, warmup: 48 },
};

function item(name: string): HTMLElement {
  const row = within(screen.getByRole("region", { name: "Conditions" }))
    .getAllByRole("listitem")
    .find((element) => element.textContent?.includes(name));
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

describe("ConditionsPanel", () => {
  it("should list each condition with its definition, its value and its state when it is given conditions", () => {
    render(<ConditionsPanel conditions={[ready, warming]} />);

    const rows = within(screen.getByRole("region", { name: "Conditions" })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const vwap = item("Price vs VWAP");
    expect(within(vwap).getByText("above")).toBeTruthy();
    expect(within(vwap).getByText(ready.value)).toBeTruthy();
    expect(within(vwap).getByText(ready.definition)).toBeTruthy();
  });

  it("should word a warming input as warming with its counts, never as a state, when an input is not ready", () => {
    render(<ConditionsPanel conditions={[ready, warming]} />);

    const ema = item("EMA 13 vs EMA 48");
    const reading = within(ema).getByText("warming 20/48");
    expect(reading.getAttribute("data-reading")).toBe("warming");
    expect(within(item("Price vs VWAP")).getByText("above").getAttribute("data-reading")).toBe("state");
    expect(within(ema).queryByText(/^(above|below|at|inside)$/)).toBeNull();
  });

  it("should say the states are descriptions and suggest nothing when it is shown", () => {
    render(<ConditionsPanel conditions={[ready]} />);

    const note = within(screen.getByRole("region", { name: "Conditions" })).getByRole("note");
    expect(note.textContent).toMatch(/closed bars or the current book/);
    expect(note.textContent).toMatch(/no score/);
  });

  it("should fold to its heading when the viewer presses its heading", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<ConditionsPanel conditions={[ready]} fold={{ collapsed: false, onToggle }} />);

    await user.click(within(screen.getByRole("region", { name: "Conditions" })).getByRole("button", { name: /^Conditions$/ }));

    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

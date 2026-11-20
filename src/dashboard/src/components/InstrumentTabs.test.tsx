// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { instrumentSummaryFixture, instrumentsFixture } from "../test/fixtures.ts";
import { InstrumentTabs } from "./InstrumentTabs.tsx";

const quotes = instrumentsFixture();

afterEach(() => {
  cleanup();
});

describe("InstrumentTabs", () => {
  it("should switch, add and remove favorites from one menu", async () => {
    const user = userEvent.setup();
    const selected: string[] = [];
    const watched: { root: string; on: boolean }[] = [];
    const other = quotes.find((quote) => quote.instrument.root !== "ES");
    expect(other).toBeTruthy();
    render(
      <InstrumentTabs
        selected="ES"
        quotes={quotes}
        watchlist={["ES"]}
        onSelect={(root) => selected.push(root)}
        onWatch={(root, on) => watched.push({ root, on })}
        onOpen={() => undefined}
      />,
    );

    expect(screen.queryByRole("tablist", { name: "Instruments" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /ES/ }));
    await user.click(screen.getByRole("button", { name: `Add ${other?.instrument.root} to the watchlist` }));
    await user.click(screen.getByRole("button", { name: "Remove ES from the watchlist" }));
    await user.click(screen.getByRole("button", { name: "Chart ES" }));

    expect(watched).toEqual([
      { root: other?.instrument.root, on: true },
      { root: "ES", on: false },
    ]);
    expect(selected).toEqual(["ES"]);
    expect(screen.getByLabelText("Recent level touches")).toBeTruthy();
  });
});
// A touch chip says how its touches ended and opens its product in Detail.
// (REQUIREMENTS.md FR-79)
describe("InstrumentTabs touch lane", () => {
  const pdh = { name: "PDH", priceTicks: 100, isHigh: true, touches: 2, lastTouchMs: 200, isThirdTouch: false, held: 1, broke: 1 };
  const lane = [
    { ...instrumentSummaryFixture({ root: "NQ" }), levels: [{ ...pdh, lastTouchMs: 300 }] },
    { ...instrumentSummaryFixture({ root: "MES" }), levels: [pdh] },
  ];

  it("should show each touch's held and broke counts with starred products first when the lane lists touches", () => {
    render(<InstrumentTabs selected="MES" quotes={lane} watchlist={["MES"]} onSelect={() => undefined} onWatch={() => undefined} onOpen={() => undefined} />);

    const chips = within(screen.getByRole("list", { name: "Recent level touches" })).getAllByRole("button");
    expect(chips.map((chip) => chip.textContent)).toEqual(["MES PDH 2 touches · 1 held · 1 broke", "NQ PDH 2 touches · 1 held · 1 broke"]);
  });

  it("should open the chip's product in Detail when a chip is pressed", async () => {
    const user = userEvent.setup();
    const opened: string[] = [];
    render(<InstrumentTabs selected="MES" quotes={lane} watchlist={["MES"]} onSelect={() => undefined} onWatch={() => undefined} onOpen={(root) => opened.push(root)} />);

    await user.click(screen.getByRole("button", { name: /^NQ PDH/ }));

    expect(opened).toEqual(["NQ"]);
  });
});

// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { instrumentsFixture } from "../test/fixtures.ts";
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
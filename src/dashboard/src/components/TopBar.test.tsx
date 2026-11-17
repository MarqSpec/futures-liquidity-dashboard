// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StreamView } from "../api/marketStream.ts";
import { fromSnapshot } from "../domain/merge.ts";
import { snapshotFixture } from "../test/fixtures.ts";
import { TopBar } from "./TopBar.tsx";

// The app frame's top bar: product name, the view tabs, the session, the hub state and the exchange clock.

afterEach(cleanup);

const view: StreamView = {
  hub: "connected",
  market: null,
  awaitingSnapshot: true,
  error: null,
  resyncs: 0,
  rejectedDeltas: 0,
  depthRoots: null,
  refusedRoots: [],
};

function marketView(exchangeOpen: boolean): StreamView {
  const snapshot = snapshotFixture();
  const market = fromSnapshot({ ...snapshot, status: { ...snapshot.status, exchangeOpen } }, 30, Date.UTC(2026, 10, 10, 14, 31));
  return { ...view, market, awaitingSnapshot: false };
}

describe("TopBar", () => {
  it("should name the product and list the three view tabs when it renders", () => {
    render(<TopBar tab="detail" instrument="MES" view={view} onSelect={vi.fn()} />);

    expect([
      screen.getByText("Liquidity Dashboard").className,
      screen.getAllByRole("tab").map((tab) => tab.textContent),
    ]).toEqual(["product-name", ["Overview", "Detail: MES", "Order Flow: MES"]]);
  });

  it("should mark only the current view tab selected and focusable when it renders", () => {
    render(<TopBar tab="bookmap" instrument="MES" view={view} onSelect={vi.fn()} />);

    expect(screen.getAllByRole("tab").map((tab) => [tab.getAttribute("aria-selected"), tab.tabIndex])).toEqual([
      ["false", -1],
      ["false", -1],
      ["true", 0],
    ]);
  });

  it("should select the next tab and move focus to it when the right arrow is pressed", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<TopBar tab="overview" instrument="MES" view={view} onSelect={onSelect} />);

    screen.getByRole("tab", { name: "Overview" }).focus();
    await user.keyboard("{ArrowRight}");

    expect([onSelect.mock.calls, document.activeElement?.textContent]).toEqual([[["detail"]], "Detail: MES"]);
  });

  it("should wrap to the last tab when the left arrow is pressed on the first", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<TopBar tab="overview" instrument="MES" view={view} onSelect={onSelect} />);

    screen.getByRole("tab", { name: "Overview" }).focus();
    await user.keyboard("{ArrowLeft}");

    expect(onSelect.mock.calls).toEqual([["bookmap"]]);
  });

  it("should jump to the first and last tabs when Home and End are pressed", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<TopBar tab="detail" instrument="MES" view={view} onSelect={onSelect} />);

    screen.getByRole("tab", { name: "Detail: MES" }).focus();
    await user.keyboard("{End}{Home}");

    expect(onSelect.mock.calls).toEqual([["bookmap"], ["overview"]]);
  });

  it("should select a tab when it is clicked", async () => {
    const onSelect = vi.fn();
    render(<TopBar tab="detail" instrument="MES" view={view} onSelect={onSelect} />);

    await userEvent.setup().click(screen.getByRole("tab", { name: "Overview" }));

    expect(onSelect.mock.calls).toEqual([["overview"]]);
  });

  it("should say the market is open with the open style when the exchange is open", () => {
    render(<TopBar tab="detail" instrument="MES" view={marketView(true)} onSelect={vi.fn()} />);

    const pill = screen.getByText("Market open");

    expect(pill.className).toContain("pill-open");
  });

  it("should say the market is closed in the neutral style when the exchange is closed", () => {
    render(<TopBar tab="detail" instrument="MES" view={marketView(false)} onSelect={vi.fn()} />);

    const pill = screen.getByText("Closed");

    expect(pill.className).not.toContain("pill-open");
  });

  it("should show the hub state as a word in its state class when the hub is reconnecting", () => {
    render(<TopBar tab="detail" instrument="MES" view={{ ...view, hub: "reconnecting" }} onSelect={vi.fn()} />);

    expect(screen.getByText("reconnecting…").className).toContain("hub-reconnecting");
  });

  it("should show the exchange clock when a market snapshot has arrived", () => {
    render(<TopBar tab="detail" instrument="MES" view={marketView(true)} onSelect={vi.fn()} />);

    expect(screen.getByText(/\d\d:\d\d:\d\d CT$/)).toBeTruthy();
  });

  it("should put the theme control in the right group after the clock when it renders", () => {
    render(<TopBar tab="detail" instrument="MES" view={marketView(true)} onSelect={vi.fn()} />);

    const control = screen.getByRole("combobox", { name: "Theme" });
    const group = control.closest(".top-bar-status");
    expect(group).not.toBeNull();
    expect(group?.lastElementChild?.contains(control)).toBe(true);
  });

  it.each(["overview", "detail", "bookmap"] as const)("should offer the chart colours in the right group before the theme control when the tab is %s", (tab) => {
    render(<TopBar tab={tab} instrument="MES" view={view} onSelect={vi.fn()} />);

    const button = screen.getByRole("button", { name: "Chart colours" });
    const theme = screen.getByRole("combobox", { name: "Theme" });
    expect(button.closest(".top-bar-status")).toBe(theme.closest(".top-bar-status"));
    expect(button.compareDocumentPosition(theme) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { StreamView } from "../api/marketStream.ts";
import type { InstrumentSummary } from "../api/schemas.ts";
import { fromSnapshot } from "../domain/merge.ts";
import { instrumentsFixture, snapshotFixture } from "../test/fixtures.ts";
import { StatusBar } from "./StatusBar.tsx";

// The status bar leads with the last price and the session change, and keeps the feed status and provenance as chips.

afterEach(cleanup);

const view: StreamView = {
  hub: "connected",
  market: null,
  awaitingSnapshot: true,
  error: null,
  resyncs: 3,
  rejectedDeltas: 0,
  depthRoots: null,
  refusedRoots: [],
};

function quoted(lastTicks: number | null, changeTicks: number | null): InstrumentSummary[] {
  return instrumentsFixture().map((quote) => (quote.instrument.root === "ES" ? { ...quote, lastTicks, changeTicks } : quote));
}

function renderBar(streamView: StreamView = view, instruments: InstrumentSummary[] = instrumentsFixture()) {
  return render(
    <StatusBar
      view={streamView}
      instrument="ES"
      instruments={instruments}
    />,
  );
}

function liveView(overrides: Partial<ReturnType<typeof snapshotFixture>["status"]>): StreamView {
  const snapshot = snapshotFixture();
  const market = fromSnapshot({ ...snapshot, status: { ...snapshot.status, ...overrides } }, 30, Date.UTC(2026, 10, 10, 14, 31));
  return { ...view, market, awaitingSnapshot: false };
}

describe("StatusBar frame", () => {
  it("should show the last price in the last-price style when the product has traded", () => {
    renderBar(view, quoted(20_000, 8));

    const price = screen.getByText("Last price", { exact: false }).parentElement;

    expect([price?.className, price?.textContent]).toEqual(["last-price", "Last price 5000.00"]);
  });

  it("should show a dash for the last price when the product has not traded", () => {
    renderBar(view, quoted(null, null));

    expect(screen.getByText("Last price", { exact: false }).parentElement?.textContent).toBe("Last price —");
  });

  it("should show a positive change with its sign and an up arrow in the up tone when the session is higher", () => {
    renderBar(view, quoted(20_000, 8));

    const change = screen.getByText(/\+2\.00/);

    expect([change.textContent, change.className]).toEqual(["+2.00 ▲", "up"]);
  });

  it("should show a negative change with its sign and a down arrow in the down tone when the session is lower", () => {
    renderBar(view, quoted(20_000, -8));

    const change = screen.getByText(/−2\.00/);

    expect([change.textContent, change.className]).toEqual(["−2.00 ▼", "down"]);
  });

  it("should show no arrow and no tone when the session change is flat", () => {
    renderBar(view, quoted(20_000, 0));

    const change = screen.getByText("0.00");

    expect([change.textContent, change.className]).toEqual(["0.00", ""]);
  });

  it("should name the feed status and the provenance as two chips when a snapshot has arrived", () => {
    renderBar(liveView({}));

    const feed = screen.getByRole("status", { name: /^Feed status / });
    const provenance = screen.getByRole("status", { name: /^Data provenance / });

    expect([feed.className.includes("chip-outline"), provenance.className.includes("chip-outline")]).toEqual([false, true]);
  });

  it("should say what is degraded in lower case when the history is approximate", () => {
    renderBar(liveView({ approximate: true }));

    expect(screen.getByText("approximate history").className).toContain("chip-degraded");
  });

  it("should keep the age, sequence and resyncs on one line when a snapshot has arrived", () => {
    renderBar(liveView({}));

    expect(screen.getByTitle("Age of the last event, sequence and resyncs").textContent).toMatch(/^last event .+ · seq \d+ · resyncs 3$/);
  });

  it("should leave the session, hub state and clock to the top bar when it renders", () => {
    renderBar(liveView({}));

    expect([screen.queryByText("Market open"), screen.queryByText("connected"), screen.queryByText(/ CT$/)]).toEqual([null, null, null]);
  });
});
